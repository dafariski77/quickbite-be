import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import {
  PrismaService,
  OrderStatus,
  PickupZone,
  Category,
  Role,
} from '@micro/core';
import { SchedulerService } from '../scheduler/scheduler.service';

describe('OrdersService', () => {
  let service: OrdersService;

  const mockUser = {
    id: 'user-uuid-1',
    employeeCode: 'EMP-101',
    fullName: 'Alice Chen',
    email: 'alice.chen@company.internal',
    role: Role.EMPLOYEE,
  };

  const mockMenuItem = {
    id: 'item-uuid-1',
    name: 'Grilled Teriyaki Chicken Bowl',
    category: Category.HOT_MEAL,
    prepDurationMins: 6,
    pickupZone: PickupZone.SHELF_A,
    isAvailable: true,
    modifiersSchema: [
      {
        id: 'rice_choice',
        name: 'Rice Base',
        required: true,
        options: ['Jasmine Rice', 'Brown Rice'],
      },
      {
        id: 'spice_level',
        name: 'Spice Level',
        required: false,
        options: ['Mild', 'Spicy'],
      },
    ],
  };

  // 1 hour in future
  const futureSlotStart = new Date(Date.now() + 60 * 60 * 1000);
  const futureSlotEnd = new Date(futureSlotStart.getTime() + 10 * 60 * 1000);

  const mockSlot = {
    id: 'slot-uuid-1',
    serviceDate: new Date(),
    startTime: futureSlotStart,
    endTime: futureSlotEnd,
    maxCapacity: 15,
    bookedCount: 5,
  };

  let mockPrismaService: any;

  beforeEach(async () => {
    mockPrismaService = {
      user: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === mockUser.id) return Promise.resolve(mockUser);
          return Promise.resolve(null);
        }),
      },
      menuItem: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          if (where?.id?.in?.includes(mockMenuItem.id)) {
            return Promise.resolve([mockMenuItem]);
          }
          return Promise.resolve([]);
        }),
      },
      pickupSlot: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === mockSlot.id) return Promise.resolve(mockSlot);
          return Promise.resolve(null);
        }),
      },
      order: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(mockPrismaService)),
      $queryRaw: jest.fn().mockResolvedValue([
        { id: mockSlot.id, booked_count: 6, max_capacity: 15 },
      ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: SchedulerService,
          useValue: {
            enqueueJitFireJob: jest.fn().mockResolvedValue(undefined),
            enqueueExpiryJobs: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createOrder', () => {
    const validDto = {
      userId: mockUser.id,
      slotId: mockSlot.id,
      items: [
        {
          menuItemId: mockMenuItem.id,
          quantity: 1,
          selectedModifiers: {
            rice_choice: 'Jasmine Rice',
            spice_level: 'Mild',
          },
        },
      ],
    };

    it('should successfully create an order and calculate JIT fireAt', async () => {
      mockPrismaService.order.create.mockResolvedValue({
        id: 'order-uuid-1',
        pickupCode: '4082',
        userId: mockUser.id,
        slotId: mockSlot.id,
        status: OrderStatus.SCHEDULED,
        fireAt: new Date(futureSlotStart.getTime() - 6 * 60 * 1000), // -6m prep
        pickupZone: PickupZone.SHELF_A,
        slot: { startTime: futureSlotStart },
      });

      const order = await service.createOrder(validDto);

      expect(order).toBeDefined();
      expect(order.pickupCode).toBe('4082');
      expect(order.status).toBe(OrderStatus.SCHEDULED);
      expect(mockPrismaService.$queryRaw).toHaveBeenCalled();
    });

    it('should throw ConflictException if slot capacity is reached (race condition)', async () => {
      // 0 rows returned indicates slot was already full at atomic update
      mockPrismaService.$queryRaw.mockResolvedValue([]);

      await expect(service.createOrder(validDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw BadRequestException if item is sold out (86)', async () => {
      mockPrismaService.menuItem.findMany.mockResolvedValue([
        { ...mockMenuItem, isAvailable: false },
      ]);

      await expect(service.createOrder(validDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if required modifier is missing', async () => {
      const invalidModifiersDto = {
        ...validDto,
        items: [
          {
            menuItemId: mockMenuItem.id,
            quantity: 1,
            selectedModifiers: {}, // missing required rice_choice
          },
        ],
      };

      await expect(service.createOrder(invalidModifiersDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if an unlisted modifier option is injected', async () => {
      const injectedOptionDto = {
        ...validDto,
        items: [
          {
            menuItemId: mockMenuItem.id,
            quantity: 1,
            selectedModifiers: {
              rice_choice: 'Fried Rice with Extra Garlic Notes', // not in predefined schema
            },
          },
        ],
      };

      await expect(service.createOrder(injectedOptionDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ConflictException if slot is in the past / inside 5 min lead buffer', async () => {
      // Slot starting in 2 minutes
      const nearSlot = {
        ...mockSlot,
        id: 'slot-near',
        startTime: new Date(Date.now() + 2 * 60 * 1000),
      };
      mockPrismaService.pickupSlot.findUnique.mockResolvedValue(nearSlot);

      await expect(
        service.createOrder({ ...validDto, slotId: 'slot-near' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel order and release slot capacity when >15 mins before slot', async () => {
      const order = {
        id: 'order-1',
        pickupCode: '1234',
        slotId: mockSlot.id,
        status: OrderStatus.SCHEDULED,
        slot: {
          ...mockSlot,
          startTime: new Date(Date.now() + 30 * 60 * 1000), // 30m in future
        },
      };

      mockPrismaService.order.findUnique.mockResolvedValue(order);
      mockPrismaService.order.update.mockResolvedValue({
        ...order,
        status: OrderStatus.CANCELLED,
      });

      const result = await service.cancelOrder('order-1');

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(result.isLateCancel).toBe(false);
      expect(mockPrismaService.$executeRaw).toHaveBeenCalled();
    });

    it('should flag late cancellation when cancelled within 15 mins of slot', async () => {
      const order = {
        id: 'order-2',
        pickupCode: '5678',
        slotId: mockSlot.id,
        status: OrderStatus.SCHEDULED,
        slot: {
          ...mockSlot,
          startTime: new Date(Date.now() + 10 * 60 * 1000), // only 10m in future (< 15m)
        },
      };

      mockPrismaService.order.findUnique.mockResolvedValue(order);
      mockPrismaService.order.update.mockResolvedValue({
        ...order,
        status: OrderStatus.CANCELLED,
      });

      const result = await service.cancelOrder('order-2');

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(result.isLateCancel).toBe(true);
      expect(mockPrismaService.$executeRaw).toHaveBeenCalled();
    });

    it('should throw BadRequestException if order is already PREPARING', async () => {
      const order = {
        id: 'order-3',
        status: OrderStatus.PREPARING, // Already fired to kitchen
        slot: mockSlot,
      };

      mockPrismaService.order.findUnique.mockResolvedValue(order);

      await expect(service.cancelOrder('order-3')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
