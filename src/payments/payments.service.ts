import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentDryRunResponseDto } from './dto/payment-dry-run-response.dto';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  PAYMENT_LIMITS_PORT,
  PaymentLimitsPort,
} from './ports/payment-limits.port';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentStatus } from './entities/payment.entity';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';
import { PaymentsFilterDto } from './dto/payments-filter.dto';
import { PaymentCreatedEvent } from './events/payment-created.event';
import { PaymentCompletedEvent } from './events/payment-completed.event';
import { PaymentFailedEvent } from './events/payment-failed.event';
import { retryWithBackoff } from '../common/utils/retry';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { PaymentMetricsService } from './payment-metrics.service';
import { StructuredLogger } from '../common/logging/structured-logger';
import { PaymentStatusHistoryService } from './payment-status-history.service';

// Only PENDING payments can be transitioned; terminal states are immutable.
const ALLOWED_TRANSITIONS: Record<string, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
};

// Stable, typed error codes for the payment write path. Clients can branch on
// these without parsing human-readable messages.
export const PaymentErrorCode = {
  IDEMPOTENCY_CONFLICT: 'PAYMENT_IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_PROGRESS: 'PAYMENT_IDEMPOTENCY_IN_PROGRESS',
  DEPENDENCY_UNAVAILABLE: 'PAYMENT_DEPENDENCY_UNAVAILABLE',
  MAINNET_PAYMENTS_DISABLED: 'PAYMENT_MAINNET_DISABLED',
} as const;

export type PaymentErrorCode =
  (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

// Prisma unique-constraint violation code.
const PRISMA_UNIQUE_VIOLATION = 'P2002';

// Env var that gates mainnet payment writes. Default OFF (fail-closed):
// mainnet payments are denied unless explicitly enabled by an operator.
export const MAINNET_PAYMENTS_ENABLED_ENV = 'MAINNET_PAYMENTS_ENABLED';

// Stellar network identifiers used to decide whether a payment targets mainnet.
const MAINNET_NETWORK_IDS = new Set(['mainnet', 'public', 'pubnet']);

@Injectable()
export class PaymentsService {
  private readonly logger = new StructuredLogger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_LIMITS_PORT)
    private readonly paymentLimitsPort: PaymentLimitsPort,
    private readonly walletsService: WalletsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
    private readonly paymentMetrics: PaymentMetricsService,
    private readonly configService: ConfigService,
    private readonly statusHistory: PaymentStatusHistoryService,
  ) {}

  /**
   * Whether mainnet payment writes are enabled. Fail-closed: any value other
   * than an explicit truthy flag keeps mainnet payments disabled.
   */
  isMainnetPaymentsEnabled(): boolean {
    const raw = this.configService.get<string>(MAINNET_PAYMENTS_ENABLED_ENV);
    return raw === 'true' || raw === '1';
  }

  /**
   * Resolve the effective network for a payment. Testnet is the default so
   * testnet behavior is unchanged; only an explicit mainnet network is gated.
   */
  private resolveNetwork(createPaymentDto: CreatePaymentDto): string {
    const configured =
      this.configService.get<string>('STELLAR_NETWORK') ??
      this.configService.get<string>('NETWORK');
    const requested =
      (createPaymentDto as { network?: string }).network ?? configured;
    return (requested ?? 'testnet').toLowerCase();
  }

  private isMainnetPayment(createPaymentDto: CreatePaymentDto): boolean {
    return MAINNET_NETWORK_IDS.has(this.resolveNetwork(createPaymentDto));
  }

  /**
   * Deny-by-default guard for the mainnet money path. Throws a stable, typed
   * error when a mainnet payment is attempted while the flag is off.
   */
  private assertMainnetPaymentAllowed(createPaymentDto: CreatePaymentDto): void {
    if (!this.isMainnetPayment(createPaymentDto)) {
      return;
    }
    if (this.isMainnetPaymentsEnabled()) {
      return;
    }

    const requestId = this.requestContext.getRequestId();
    this.logger.logWithContext('Mainnet payment denied by feature flag', {
      requestId,
      entityType: 'payment',
      operation: 'create',
      outcome: 'denied',
      reason: PaymentErrorCode.MAINNET_PAYMENTS_DISABLED,
    });
    this.metrics.incrementPaymentMainnetDenied();
    this.paymentMetrics.record({
      operation: 'create',
      outcome: 'denied',
      durationMs: 0,
      currency: createPaymentDto.currency,
      failureReason: PaymentErrorCode.MAINNET_PAYMENTS_DISABLED,
    });

    throw new ForbiddenException({
      code: PaymentErrorCode.MAINNET_PAYMENTS_DISABLED,
      message: 'Mainnet payments are disabled',
      requestId,
    });
  }

  /**
   * Validate a payment exactly as creation does, without signing, submitting,
   * persisting a payment, or emitting a domain event.
   */
  async dryRun(
    createPaymentDto: CreatePaymentDto,
  ): Promise<PaymentDryRunResponseDto> {
    this.assertMainnetPaymentAllowed(createPaymentDto);
    await this.validateForCreation(createPaymentDto);

    return {
      dryRun: true,
      valid: true,
      preview: {
        senderWalletId: createPaymentDto.walletId,
        receiverWalletId: createPaymentDto.receiverWalletId,
        fromId: createPaymentDto.fromId,
        toId: createPaymentDto.toId,
        amount: createPaymentDto.amount,
        currency: createPaymentDto.currency,
        ...(createPaymentDto.assetCode
          ? { assetCode: createPaymentDto.assetCode }
          : {}),
        status: PaymentStatus.PENDING,
      },
      checks: {
        senderWallet: 'ACTIVE',
        receiverWallet: 'FOUND',
        paymentLimits: 'PASSED',
      },
    };
  }

  async create(createPaymentDto: CreatePaymentDto) {
    const requestId = this.requestContext.getRequestId();
    const clientVersion = this.requestContext.getClientVersion();
    const start = Date.now();
    const {
      fromId,
      toId,
      amount,
      currency,
      assetCode,
      description,
      idempotencyKey,
    } = createPaymentDto;

    // Fail-closed mainnet gate runs before any persistence or signing.
    this.assertMainnetPaymentAllowed(createPaymentDto);

    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.logWithContext('Idempotency hit, returning existing payment', {
          requestId,
          clientVersion,
          entityId: existing.id.toString(),
          entityType: 'payment',
          operation: 'create',
          outcome: 'idempotent',
        });
        this.metrics.incrementPaymentIdempotencyHit();
        this.paymentMetrics.record({
          operation: 'create',
          outcome: 'idempotent',
          durationMs: Date.now() - start,
          currency,
        });
        return existing;
      }
    }

    try {
      await this.validateForCreation(createPaymentDto);

      const payment = await this.prisma.payment.create({
        data: {
          fromId,
          toId,
          amount,
          currency,
          assetCode,
          description,
          userId: fromId,
          status: PaymentStatus.PENDING,
          idempotencyKey: idempotencyKey ?? null,
        },
      });

      this.metrics.incrementPaymentsCreated();
      this.paymentMetrics.record({
        operation: 'create',
        outcome: 'success',
        durationMs: Date.now() - start,
        currency,
      });

      this.eventEmitter.emit(
        'payment.created',
        new PaymentCreatedEvent(
          payment.id,
          payment.amount,
          payment.currency,
          payment.userId,
        ),
      );

      return payment;
    } catch (err) {
      // Concurrent/replayed request raced past the pre-check and lost the
      // unique-constraint race on idempotencyKey. Return the original result
      // so the write path is exactly-once instead of surfacing a 500.
      if (
        idempotencyKey &&
        err?.code === PRISMA_UNIQUE_VIOLATION &&
        this.isIdempotencyKeyViolation(err)
      ) {
        const existing = await this.prisma.payment.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          this.logger.logWithContext(
            'Idempotency conflict resolved to existing payment',
            {
              requestId,
              clientVersion,
              entityId: existing.id.toString(),
              entityType: 'payment',
              operation: 'create',
              outcome: 'idempotent',
            },
          );
          this.metrics.incrementPaymentIdempotencyHit();
          this.paymentMetrics.record({
            operation: 'create',
            outcome: 'idempotent',
            durationMs: Date.now() - start,
            currency,
          });
          return existing;
        }
        // The conflicting row is not visible yet (in-flight transaction).
        // Fail closed with a stable, retryable error code.
        this.metrics.incrementPaymentIdempotencyConflict();
        this.paymentMetrics.record({
          operation: 'create',
          outcome: 'conflict',
          durationMs: Date.now() - start,
          currency,
          failureReason: PaymentErrorCode.IDEMPOTENCY_IN_PROGRESS,
        });
        throw new ConflictException({
          code: PaymentErrorCode.IDEMPOTENCY_IN_PROGRESS,
          message:
            'A payment with this idempotency key is already being processed',
          requestId,
        });
      }

      this.paymentMetrics.record({
        operation: 'create',
        outcome: 'failure',
        durationMs: Date.now() - start,
        currency,
        failureReason: err?.constructor?.name ?? 'unknown',
      })

/* … truncated 4173 chars — edit only what you need near the top … */
