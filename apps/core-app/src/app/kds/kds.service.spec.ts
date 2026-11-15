import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Response } from 'express';
import { KdsService } from './kds.service';
import { PrismaService, OrderStatus, PickupZone, Category } from '@micro/core';
import { ORDER_READY_EVENT } from '../scheduler/events/order.events';

const mockPrismaService = {
  pickupSlot: {
    findMany: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockEventEmitter = {
  emit: jest.fn(),
};

interface MockResponse {
  setHeader: jest.Mock;
  flushHeaders: jest.Mock;
  write: jest.Mock;
  on: jest.Mock;
  _trigger: (event: string) => void;
}

// Minimal mock Express Response for SSE
const makeMockRes = (): Response & MockResponse => {
  const handlers: Record<string, () => void> = {};
  return {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    on: jest.fn((event: string, handler: () => void) => {
      handlers[event] = handler;
    }),
    _trigger: (event: string) => handlers[event]?.(),
  } as unknown as Response & MockResponse;
};

const preparingOrder = {
  id: 'order-uuid-1',
  pickupCode: '4082',
  userId: 'user-uuid-1',
  slotId: 'slot-uuid-1',
  pickupZone: PickupZone.SHELF_A,
  status: OrderStatus.PREPARING,
  slot: { startTime: new Date() },
  user: { id: 'user-uuid-1', employeeCode: 'EMP-101' },
};

describe('KdsService', () => {
  let service: KdsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KdsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<KdsService>(KdsService);
  });

  // ─── getForecast ──────────────────────────────────────────────────────────────

  describe('getForecast', () => {
    it('should return aggregated item counts per upcoming slot', async () => {
      mockPrismaService.pickupSlot.findMany.mockResolvedValue([
        {
          id: 'slot-1',
          startTime: new Date('2026-11-15T12:00:00Z'),
          endTime: new Date('2026-11-15T12:10:00Z'),
          orders: [
            {
              status: OrderStatus.SCHEDULED,
              orderItems: [
                {
                  menuItemId: 'item-1',
                  quantity: 2,
                  menuItem: {
                    name: 'Chicken Bowl',
                    category: Category.HOT_MEAL,
                  },
                },
                {
                  menuItemId: 'item-2',
                  quantity: 1,
                  menuItem: {
                    name: 'Iced Latte',
                    category: Category.COLD_DRINK,
                  },
                },
              ],
            },
            {
              status: OrderStatus.PREPARING,
              orderItems: [
                {
                  menuItemId: 'item-1',
                  quantity: 1,
                  menuItem: {
                    name: 'Chicken Bowl',
                    category: Category.HOT_MEAL,
                  },
                },
              ],
            },
          ],
        },
      ]);

      const result = await service.getForecast();

      expect(result).toHaveLength(1);
      expect(result[0].slotId).toBe('slot-1');
      expect(result[0].totalOrders).toBe(2);

      const chickenBowl = result[0].items.find(
        (i) => i.name === 'Chicken Bowl',
      );
      const icedLatte = result[0].items.find((i) => i.name === 'Iced Latte');

      // 2 from first order + 1 from second order
      expect(chickenBowl?.totalQuantity).toBe(3);
      expect(icedLatte?.totalQuantity).toBe(1);
    });

    it('should return empty items array for slots with no orders', async () => {
      mockPrismaService.pickupSlot.findMany.mockResolvedValue([
        {
          id: 'slot-empty',
          startTime: new Date(),
          endTime: new Date(),
          orders: [],
        },
      ]);

      const result = await service.getForecast();
      expect(result[0].items).toHaveLength(0);
      expect(result[0].totalOrders).toBe(0);
    });
  });

  // ─── markOrderReady ───────────────────────────────────────────────────────────

  describe('markOrderReady', () => {
    it('should update order to READY_FOR_PICKUP and emit order.ready event', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(preparingOrder);
      mockPrismaService.order.update.mockResolvedValue({
        ...preparingOrder,
        status: OrderStatus.READY_FOR_PICKUP,
        readyAt: new Date(),
        orderItems: [],
      });

      const result = await service.markOrderReady(preparingOrder.id);

      expect(mockPrismaService.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: preparingOrder.id },
          data: expect.objectContaining({
            status: OrderStatus.READY_FOR_PICKUP,
          }),
        }),
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_READY_EVENT,
        expect.objectContaining({
          orderId: preparingOrder.id,
          pickupCode: '4082',
        }),
      );

      expect(result.status).toBe(OrderStatus.READY_FOR_PICKUP);
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);

      await expect(service.markOrderReady('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if order is not in PREPARING state', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({
        ...preparingOrder,
        status: OrderStatus.SCHEDULED,
      });

      await expect(service.markOrderReady(preparingOrder.id)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── SSE client management ────────────────────────────────────────────────────

  describe('addKdsClient', () => {
    it('should register the client and send initial connected event', () => {
      const res = makeMockRes();
      service.addKdsClient(res);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/event-stream',
      );
      expect(res.flushHeaders).toHaveBeenCalled();
      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('event: connected'),
      );
    });

    it('should remove client on connection close', () => {
      const res = makeMockRes();
      service.addKdsClient(res);
      res._trigger('close');

      // After close, broadcasting should not call write on the removed client
      service.handleOrderFired({
        orderId: 'x',
        pickupCode: '1234',
        userId: 'u',
        slotId: 's',
        pickupZone: PickupZone.SHELF_A,
      });
      // res.write was called once (for 'connected'), but not again after close
      expect(res.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('addOrderClient', () => {
    it('should register the iOS client and send initial connected event', () => {
      const res = makeMockRes();
      service.addOrderClient('order-uuid-1', res);

      expect(res.flushHeaders).toHaveBeenCalled();
      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('event: connected'),
      );
    });

    it('should broadcast order_ready to the correct order client only', () => {
      const res1 = makeMockRes();
      const res2 = makeMockRes();

      service.addOrderClient('order-A', res1);
      service.addOrderClient('order-B', res2);

      service.handleOrderReady({
        orderId: 'order-A',
        pickupCode: '1111',
        userId: 'u1',
        pickupZone: PickupZone.SHELF_A,
      });

      // res1 should have received the order_ready event (1 initial + 1 broadcast)
      expect(res1.write).toHaveBeenCalledTimes(2);
      // res2 should NOT have received it
      expect(res2.write).toHaveBeenCalledTimes(1); // only initial connected
    });
  });
});
