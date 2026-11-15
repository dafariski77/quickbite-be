import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  JIT_FIRE_QUEUE,
  ORDER_EXPIRY_QUEUE,
  JIT_FIRE_JOB,
  ORDER_REMINDER_JOB,
  ORDER_EXPIRY_JOB,
} from './constants';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(JIT_FIRE_QUEUE) private readonly jitFireQueue: Queue,
    @InjectQueue(ORDER_EXPIRY_QUEUE) private readonly orderExpiryQueue: Queue,
  ) {}

  /**
   * Enqueue the JIT firing job for an order.
   * Delay is computed from fireAt; if fireAt is in the past, fires immediately (delay = 0).
   */
  async enqueueJitFireJob(orderId: string, fireAt: Date): Promise<void> {
    const delay = Math.max(0, fireAt.getTime() - Date.now());

    await this.jitFireQueue.add(
      JIT_FIRE_JOB,
      { orderId },
      {
        delay,
        jobId: `jit-${orderId}`, // idempotent — prevents duplicate jobs on retry
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `📅 JIT fire job queued — orderId: ${orderId}, fireAt: ${fireAt.toISOString()}, delay: ${delay}ms`,
    );
  }

  /**
   * Enqueue the 20-min reminder and 30-min expiry jobs for a completed order.
   * Both are anchored to slotStartTime (when the pickup window opens).
   */
  async enqueueExpiryJobs(orderId: string, slotStartTime: Date): Promise<void> {
    const slotMs = slotStartTime.getTime();
    const reminderDelay = Math.max(0, slotMs + 20 * 60 * 1000 - Date.now());
    const expiryDelay = Math.max(0, slotMs + 30 * 60 * 1000 - Date.now());

    await this.orderExpiryQueue.add(
      ORDER_REMINDER_JOB,
      { orderId },
      {
        delay: reminderDelay,
        jobId: `reminder-${orderId}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    await this.orderExpiryQueue.add(
      ORDER_EXPIRY_JOB,
      { orderId },
      {
        delay: expiryDelay,
        jobId: `expiry-${orderId}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `⏰ Expiry jobs queued — orderId: ${orderId}, reminder: ${reminderDelay}ms, expiry: ${expiryDelay}ms`,
    );
  }
}
