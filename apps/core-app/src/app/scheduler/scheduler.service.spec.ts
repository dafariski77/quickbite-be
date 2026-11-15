import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { SchedulerService } from './scheduler.service';
import { JIT_FIRE_QUEUE, ORDER_EXPIRY_QUEUE, JIT_FIRE_JOB, ORDER_REMINDER_JOB, ORDER_EXPIRY_JOB } from './constants';

const mockJitFireQueue = { add: jest.fn() };
const mockOrderExpiryQueue = { add: jest.fn() };

describe('SchedulerService', () => {
  let service: SchedulerService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: getQueueToken(JIT_FIRE_QUEUE), useValue: mockJitFireQueue },
        { provide: getQueueToken(ORDER_EXPIRY_QUEUE), useValue: mockOrderExpiryQueue },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
  });

  describe('enqueueJitFireJob', () => {
    it('should enqueue a delayed JIT fire job with the correct delay', async () => {
      const orderId = 'order-uuid-1';
      const fireAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins from now

      await service.enqueueJitFireJob(orderId, fireAt);

      expect(mockJitFireQueue.add).toHaveBeenCalledTimes(1);
      const [jobName, jobData, jobOpts] = mockJitFireQueue.add.mock.calls[0];

      expect(jobName).toBe(JIT_FIRE_JOB);
      expect(jobData).toEqual({ orderId });
      expect(jobOpts.jobId).toBe(`jit-${orderId}`);
      // Delay should be approximately 10 minutes (allow ±1s drift)
      expect(jobOpts.delay).toBeGreaterThan(9 * 60 * 1000);
      expect(jobOpts.delay).toBeLessThanOrEqual(10 * 60 * 1000 + 100);
    });

    it('should use delay = 0 when fireAt is in the past', async () => {
      const orderId = 'order-uuid-past';
      const fireAt = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago

      await service.enqueueJitFireJob(orderId, fireAt);

      expect(mockJitFireQueue.add).toHaveBeenCalledTimes(1);
      const [, , jobOpts] = mockJitFireQueue.add.mock.calls[0];
      expect(jobOpts.delay).toBe(0);
    });
  });

  describe('enqueueExpiryJobs', () => {
    it('should enqueue both reminder and expiry jobs with correct delays', async () => {
      const orderId = 'order-uuid-2';
      // Slot starts 1 hour from now
      const slotStartTime = new Date(Date.now() + 60 * 60 * 1000);

      await service.enqueueExpiryJobs(orderId, slotStartTime);

      expect(mockOrderExpiryQueue.add).toHaveBeenCalledTimes(2);

      const [reminderName, reminderData, reminderOpts] = mockOrderExpiryQueue.add.mock.calls[0];
      const [expiryName, expiryData, expiryOpts] = mockOrderExpiryQueue.add.mock.calls[1];

      expect(reminderName).toBe(ORDER_REMINDER_JOB);
      expect(reminderData).toEqual({ orderId });
      expect(reminderOpts.jobId).toBe(`reminder-${orderId}`);

      expect(expiryName).toBe(ORDER_EXPIRY_JOB);
      expect(expiryData).toEqual({ orderId });
      expect(expiryOpts.jobId).toBe(`expiry-${orderId}`);

      // Reminder should fire 20 min after slot start → ~80 mins from now
      expect(reminderOpts.delay).toBeGreaterThan(79 * 60 * 1000);
      // Expiry should fire 30 min after slot start → ~90 mins from now
      expect(expiryOpts.delay).toBeGreaterThan(89 * 60 * 1000);
      // Expiry must be later than reminder
      expect(expiryOpts.delay).toBeGreaterThan(reminderOpts.delay);
    });

    it('should clamp both delays to 0 when slot start is in the past', async () => {
      const orderId = 'order-uuid-past-slot';
      const slotStartTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      await service.enqueueExpiryJobs(orderId, slotStartTime);

      const [, , reminderOpts] = mockOrderExpiryQueue.add.mock.calls[0];
      const [, , expiryOpts] = mockOrderExpiryQueue.add.mock.calls[1];

      expect(reminderOpts.delay).toBe(0);
      expect(expiryOpts.delay).toBe(0);
    });
  });
});
