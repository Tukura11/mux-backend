import { Injectable, Logger, NotFoundException, ForbiddenException, ConflictException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Wallet, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * Stable error codes for wallet successor operations.
 * Clients should branch on these codes, not on human-readable messages.
 */
export const WalletSuccessorErrorCode = {
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  SUCCESSOR_NOT_FOUND: 'SUCCESSOR_NOT_FOUND',
  SELF_REFERENCE: 'SELF_REFERENCE',
  SUCCESSOR_CYCLE: 'SUCCESSOR_CYCLE',
  SUCCESSOR_ALREADY_SET: 'SUCCESSOR_ALREADY_SET',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type WalletSuccessorErrorCode =
  (typeof WalletSuccessorErrorCode)[keyof typeof WalletSuccessorErrorCode];

/**
 * Actor context for authorization. Deny-by-default: only the wallet owner
 * (or an explicitly authorized delegate/guardian) may mutate successor_id.
 */
export interface SuccessorActor {
  /** Subject id of the caller (user id, delegate id, guardian id). */
  subjectId: string;
  /** Role of the caller. */
  role: 'owner' | 'delegate' | 'guardian' | 'api-key' | 'jwt';
  /** Correlation id propagated from the request for tracing. */
  correlationId?: string;
}

export interface SetSuccessorResult {
  walletId: string;
  successorId: string | null;
  correlationId: string;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the current successor_id for a wallet.
   * Returns null when no successor is set.
   */
  async getSuccessor(walletId: string): Promise<string | null> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { id: true, successorId: true },
    });
    if (!wallet) {
      throw new NotFoundException({
        code: WalletSuccessorErrorCode.WALLET_NOT_FOUND,
        message: `Wallet ${walletId} not found`,
      });
    }
    return wallet.successorId ?? null;
  }

  /**
   * Set (or clear, when successorId is null) the successor for a wallet.
   *
   * Invariants enforced:
   *  - Caller must be the wallet owner or an authorized delegate/guardian.
   *  - Successor must exist and be owned by the same owner (no cross-tenant).
   *  - No self-reference.
   *  - No cycles in the successor chain.
   *  - Single active successor per wallet (idempotent on replay).
   *  - Fail-closed on dependency outages for writes.
   */
  async setSuccessor(
    walletId: string,
    successorId: string | null,
    actor: SuccessorActor,
  ): Promise<SetSuccessorResult> {
    const correlationId = actor.correlationId ?? randomUUID();

    // Deny-by-default: only owner/delegate/guardian may mutate successor.
    if (!['owner', 'delegate', 'guardian'].includes(actor.role)) {
      this.logger.warn(
        `successor.set denied wallet=${walletId} role=${actor.role} correlationId=${correlationId}`,
      );
      throw new ForbiddenException({
        code: WalletSuccessorErrorCode.NOT_AUTHORIZED,
        message: 'Caller is not authorized to change wallet successor',
        correlationId,
      });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: { id: walletId },
          select: { id: true, ownerId: true, successorId: true },
        });
        if (!wallet) {
          throw new NotFoundException({
            code: WalletSuccessorErrorCode.WALLET_NOT_FOUND,
            message: `Wallet ${walletId} not found`,
            correlationId,
          });
        }

        // Authorization: owner must match, or caller must be an authorized
        // delegate/guardian recorded on the wallet.
        if (actor.role === 'owner' && wallet.ownerId !== actor.subjectId) {
          throw new ForbiddenException({
            code: WalletSuccessorErrorCode.NOT_AUTHORIZED,
            message: 'Caller does not own this wallet',
            correlationId,
          });
        }
        if (actor.role !== 'owner') {
          const authorized = await this.isAuthorizedDelegate(
            tx,
            walletId,
            actor.subjectId,
            actor.role,
          );
          if (!authorized) {
            throw new ForbiddenException({
              code: WalletSuccessorErrorCode.NOT_AUTHORIZED,
              message: 'Delegate/guardian is not authorized for this wallet',
              correlationId,
            });
          }
        }

        // Idempotency: replaying the same assignment is a no-op success.
        if ((wallet.successorId ?? null) === (successorId ?? null)) {
          return { walletId, successorId: successorId ?? null, correlationId };
        }

        if (successorId !== null) {
          if (successorId === walletId) {
            throw new BadRequestException({
              code: WalletSuccessorErrorCode.SELF_REFERENCE,
              message: 'A wallet cannot be its own successor',
              correlationId,
            });
          }

          const successor = await tx.wallet.findUnique({
            where: { id: successorId },
            select: { id: true, ownerId: true },
          });
          if (!successor) {
            throw new NotFoundException({
              code: WalletSuccessorErrorCode.SUCCESSOR_NOT_FOUND,
              message: `Successor wallet ${successorId} not found`,
              correlationId,
            });
          }
          if (successor.ownerId !== wallet.ownerId) {
            throw new ForbiddenException({
              code: WalletSuccessorErrorCode.NOT_AUTHORIZED,
              message: 'Successor must be owned by the same owner',
              correlationId,
            });
          }

          // Cycle detection: walk the successor chain from the proposed
          // successor; if we reach walletId, the assignment would create a cycle.
          if (await this.wouldCreateCycle(tx, walletId, successorId)) {
            throw new ConflictException({
              code: WalletSuccessorErrorCode.SUCCESSOR_CYCLE,
              message: 'Successor assignment would create a cycle',
              correlationId,
            });
          }
        }

        await tx.wallet.update({
          where: { id: walletId },
          data: { successorId: successorId ?? null },
        });

        this.logger.log(
          `successor.set wallet=${walletId} successor=${successorId ?? 'null'} role=${actor.role} correlationId=${correlationId}`,
        );

        return { walletId, successorId: successorId ?? null, correlationId };
      });
    } catch (err) {
      // Fail-closed: surface dependency outages as 503, never silently succeed.
      if (this.isDependencyError(err)) {
        this.logger.error(
          `successor.set dependency failure wallet=${walletId} correlationId=${correlationId}`,
        );
        throw new ServiceUnavailableException({
          code: WalletSuccessorErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'Wallet store unavailable; write rejected',
          correlationId,
        });
      }
      throw err;
    }
  }

  /**
   * Clear the successor for a wallet. Idempotent.
   */
  async clearSuccessor(
    walletId: string,
    actor: SuccessorActor,
  ): Promise<SetSuccessorResult> {
    return this.setSuccessor(walletId, null, actor);
  }

  /**
   * Walk the successor chain from `startId`; return true if it reaches `targetId`.
   * Bounded to avoid unbounded traversal on corrupt data.
   */
  private async wouldCreateCycle(
    tx: Prisma.TransactionClient,
    targetId: string,
    startId: string,
  ): Promise<boolean> {
    const MAX_DEPTH = 64;
    let current: string | null = startId;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
      if (current === targetId) return true;
      if (seen.has(current)) return true; // pre-existing cycle: refuse
      seen.add(current);
      const next: { successorId: string | null } | null =
        await tx.wallet.findUnique({
          where: { id: current },
          select: { successorId: true },
        });
      current = next?.successorId ?? null;
    }
    return false;
  }

  /**
   * Check whether `subjectId` is an authorized delegate/guardian for the wallet.
   * Deny-by-default when no matching grant exists.
   */
  private async isAuthorizedDelegate(
    tx: Prisma.TransactionClient,
    walletId: string,
    subjectId: string,
    role: 'delegate' | 'guardian',
  ): Promise<boolean> {
    const grant = await tx.walletDelegate.findFirst({
      where: { walletId, subjectId, role, revokedAt: null },
      select: { id: true },
    });
    return grant !== null;
  }

  private isDependencyError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P1001/P1002/P1008/P1017: connection / timeout / unreachable.
      return ['P1001', 'P1002', 'P1008', 'P1017'].includes(err.code);
    }
    if (err instanceof Prisma.PrismaClientInitializationError) return true;
    if (err instanceof Prisma.PrismaClientRustPanicError) return true;
    return false;
  }
}
