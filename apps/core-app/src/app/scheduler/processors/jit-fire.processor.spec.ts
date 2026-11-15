import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { JitFireProcessor } from './jit-fire.processor';
import { PrismaService, OrderStatus, PickupZone } from '@micro/core';
import { JIT_FIRE_JOB } from '../constants';
import { ORDER_FIRED_EVENT } from '../events/order.events';

const mockPrismaService = {
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockEventEmitter = {
  emit: jest.fn(),
};

const makeJob = (data: { orderId: string }, name = JIT_FIRE_JOB) =>
  ({ name, data } as unknown as Job<{ orderId: string }>);

const scheduledOrder = {
  id: 'order-uuid',
  pickupCode: '1234',
  userId: 'user-uuid',
  slotId: 'slot-uuid',
  pickupZone: PickupZone.SHELF_A,
  status: OrderStatus.SCHEDULED,
  slot: { startTime: new Date() },
};

describe('JitFireProcessor', () => {
  let processor: JitFireProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JitFireProcessor,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    processor = module.get<JitFireProcessor>(JitFireProcessor);
  });

  it('should transition SCHEDULED order to PREPARING and emit order.fired event', async () => {
    mockPrismaService.order.findUnique.mockResolvedValue(scheduledOrder);
    mockPrismaService.order.update.mockResolvedValue({
      ...scheduledOrder,
      status: OrderStatus.PREPARING,
    });

    await processor.process(makeJob({ orderId: scheduledOrder.id }));

    expect(mockPrismaService.order.update).toHaveBeenCalledWith({
      where: { id: scheduledOrder.id },
      data: { status: OrderStatus.PREPARING },
    });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      ORDER_FIRED_EVENT,
      expect.objectContaining({ orderId: scheduledOrder.id, pickupCode: '1234' }),
    );
  });

  it('should skip processing if order is CANCELLED', async () => {
    mockPrismaService.order.findUnique.mockResolvedValue({
      ...scheduledOrder,
      status: OrderStatus.CANCELLED,
    });

    await processor.process(makeJob({ orderId: scheduledOrder.id }));

    expect(mockPrismaService.order.update).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should skip processing if order is not found', async () => {
    mockPrismaService.order.findUnique.mockResolvedValue(null);

    await processor.process(makeJob({ orderId: 'nonexistent' }));

    expect(mockPrismaService.order.update).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should skip processing for unknown job names', async () => {
    await processor.process(makeJob({ orderId: scheduledOrder.id }, 'unknown-job'));

    expect(mockPrismaService.order.findUnique).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });
});
