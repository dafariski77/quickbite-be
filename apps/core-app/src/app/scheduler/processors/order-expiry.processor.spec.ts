import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { OrderExpiryProcessor } from './order-expiry.processor';
import { PrismaService, OrderStatus } from '@micro/core';
import { ORDER_REMINDER_JOB, ORDER_EXPIRY_JOB } from '../constants';
import { ORDER_REMINDER_EVENT, ORDER_EXPIRED_EVENT } from '../events/order.events';

const mockPrismaService = {
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockEventEmitter = {
  emit: jest.fn(),
};

const makeJob = (data: { orderId: string }, name: string) =>
  ({ name, data } as unknown as Job<{ orderId: string }>);

const readyOrder = {
  id: 'order-uuid',
  pickupCode: '5678',
  userId: 'user-uuid',
  status: OrderStatus.READY_FOR_PICKUP,
};

describe('OrderExpiryProcessor', () => {
  let processor: OrderExpiryProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderExpiryProcessor,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    processor = module.get<OrderExpiryProcessor>(OrderExpiryProcessor);
  });

  describe('ORDER_REMINDER_JOB', () => {
    it('should emit order.reminder when order is READY_FOR_PICKUP', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(readyOrder);

      await processor.process(makeJob({ orderId: readyOrder.id }, ORDER_REMINDER_JOB));

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_REMINDER_EVENT,
        expect.objectContaining({ orderId: readyOrder.id, pickupCode: '5678' }),
      );
      expect(mockPrismaService.order.update).not.toHaveBeenCalled();
    });

    it('should skip reminder if order is COMPLETED', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({
        ...readyOrder,
        status: OrderStatus.COMPLETED,
      });

      await processor.process(makeJob({ orderId: readyOrder.id }, ORDER_REMINDER_JOB));

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should skip reminder if order is not found', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);

      await processor.process(makeJob({ orderId: 'nonexistent' }, ORDER_REMINDER_JOB));

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('ORDER_EXPIRY_JOB', () => {
    it('should update status to EXPIRED and emit order.expired when READY_FOR_PICKUP', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(readyOrder);
      mockPrismaService.order.update.mockResolvedValue({
        ...readyOrder,
        status: OrderStatus.EXPIRED,
      });

      await processor.process(makeJob({ orderId: readyOrder.id }, ORDER_EXPIRY_JOB));

      expect(mockPrismaService.order.update).toHaveBeenCalledWith({
        where: { id: readyOrder.id },
        data: { status: OrderStatus.EXPIRED },
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_EXPIRED_EVENT,
        expect.objectContaining({ orderId: readyOrder.id, pickupCode: '5678' }),
      );
    });

    it('should skip expiry if order is already COMPLETED', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({
        ...readyOrder,
        status: OrderStatus.COMPLETED,
      });

      await processor.process(makeJob({ orderId: readyOrder.id }, ORDER_EXPIRY_JOB));

      expect(mockPrismaService.order.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should skip expiry if order is not found', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);

      await processor.process(makeJob({ orderId: 'nonexistent' }, ORDER_EXPIRY_JOB));

      expect(mockPrismaService.order.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  it('should skip for unknown job names', async () => {
    await processor.process(makeJob({ orderId: readyOrder.id }, 'unknown-job'));

    expect(mockPrismaService.order.findUnique).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });
});
