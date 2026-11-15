/**
 * PRD REQUIREMENT TRACEABILITY SUITE
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps every testable PRD user story & algorithm to a concrete assertion.
 * Each describe block is labeled with the PRD section it covers.
 * Run: NX_ISOLATE_PLUGINS=false npx nx run @micro/core-app:test
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  Type,
  Provider,
} from '@nestjs/common';

// Services under test
import { MenuService } from '../menu/menu.service';
import { SlotsService } from '../slots/slots.service';
import { OrdersService } from '../orders/orders.service';
import { KdsService } from '../kds/kds.service';
import { JitFireProcessor } from '../scheduler/processors/jit-fire.processor';
import { OrderExpiryProcessor } from '../scheduler/processors/order-expiry.processor';
import { SchedulerService } from '../scheduler/scheduler.service';

// Core types
import {
  PrismaService,
  OrderStatus,
  PickupZone,
  Category,
  Role,
  calculateSlotBadge,
  SlotCongestionBadge,
  PickupSlot,
} from '@micro/core';
import {
  ORDER_FIRED_EVENT,
  ORDER_READY_EVENT,
  ORDER_REMINDER_EVENT,
  ORDER_EXPIRED_EVENT,
} from '../scheduler/events/order.events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  JIT_FIRE_JOB,
  ORDER_REMINDER_JOB,
  ORDER_EXPIRY_JOB,
  JIT_FIRE_QUEUE,
  ORDER_EXPIRY_QUEUE,
} from '../scheduler/constants';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';

// ─── Shared mocks ─────────────────────────────────────────────────────────────

type MockFn = jest.Mock;

interface MockPrismaClient {
  user: { findUnique: MockFn };
  menuItem: { findUnique: MockFn; findMany: MockFn; update: MockFn };
  pickupSlot: {
    findUnique: MockFn;
    findMany: MockFn;
    update: MockFn;
    upsert: MockFn;
  };
  order: {
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
  };
  $transaction: MockFn;
  $queryRaw: MockFn;
  $executeRaw: MockFn;
}

const mockPrisma: MockPrismaClient = {
  user: { findUnique: jest.fn() },
  menuItem: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  pickupSlot: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((cb: (tx: MockPrismaClient) => unknown) =>
    cb(mockPrisma),
  ),
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

const mockEventEmitter = { emit: jest.fn() };
const mockSchedulerService = {
  enqueueJitFireJob: jest.fn().mockResolvedValue(undefined),
  enqueueExpiryJobs: jest.fn().mockResolvedValue(undefined),
};
const mockJitQueue = { add: jest.fn() };
const mockExpiryQueue = { add: jest.fn() };

// Shared fixtures
const USER = {
  id: 'user-uuid',
  employeeCode: 'EMP-001',
  fullName: 'Alice Chen',
  email: 'alice@company.internal',
  role: Role.EMPLOYEE,
};

const MENU_ITEM = {
  id: 'item-uuid',
  name: 'Grilled Chicken Bowl',
  category: Category.HOT_MEAL,
  prepDurationMins: 6,
  pickupZone: PickupZone.SHELF_A,
  isAvailable: true,
  modifiersSchema: [
    {
      id: 'rice',
      name: 'Rice Base',
      required: true,
      options: ['Jasmine', 'Brown'],
    },
    {
      id: 'spice',
      name: 'Spice Level',
      required: false,
      options: ['Mild', 'Spicy'],
    },
  ],
};

const SLOT_1H_FUTURE = {
  id: 'slot-uuid',
  serviceDate: new Date(),
  startTime: new Date(Date.now() + 60 * 60 * 1000),
  endTime: new Date(Date.now() + 70 * 60 * 1000),
  maxCapacity: 15,
  bookedCount: 5,
};

const VALID_ORDER_DTO = {
  userId: USER.id,
  slotId: SLOT_1H_FUTURE.id,
  items: [
    {
      menuItemId: MENU_ITEM.id,
      quantity: 1,
      selectedModifiers: { rice: 'Jasmine', spice: 'Mild' },
    },
  ],
};

const makeJob = <T>(data: T, name: string) =>
  ({ name, data }) as unknown as Job<T>;

// ─── Helper: build module ────────────────────────────────────────────────────

async function buildModule<T>(
  Service: Type<T>,
  extraProviders: Provider[] = [],
) {
  const providers: Provider[] = [
    Service,
    { provide: PrismaService, useValue: mockPrisma },
    { provide: EventEmitter2, useValue: mockEventEmitter },
    { provide: getQueueToken(JIT_FIRE_QUEUE), useValue: mockJitQueue },
    { provide: getQueueToken(ORDER_EXPIRY_QUEUE), useValue: mockExpiryQueue },
  ];

  if (Service !== SchedulerService) {
    providers.push({
      provide: SchedulerService,
      useValue: mockSchedulerService,
    });
  }

  providers.push(...extraProviders);

  const module: TestingModule = await Test.createTestingModule({
    providers,
  }).compile();
  return module;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EPIC 2 — HIGH-SPEED MENU & 1-TAP REORDERING
// ═══════════════════════════════════════════════════════════════════════════════

describe('[PRD §2 — Epic 2] Menu & Modifiers', () => {
  let menuService: MenuService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const m = await buildModule(MenuService);
    menuService = m.get(MenuService);
  });

  describe('US-2.3: Real-Time Stock Sync', () => {
    it('toggleItemStock(id, false) marks item unavailable — 86 from ordering', async () => {
      mockPrisma.menuItem.findUnique.mockResolvedValue(MENU_ITEM);
      mockPrisma.menuItem.update.mockResolvedValue({
        ...MENU_ITEM,
        isAvailable: false,
      });

      const result = await menuService.toggleItemStock(MENU_ITEM.id, false);

      expect(mockPrisma.menuItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isAvailable: false } }),
      );
      expect(result.isAvailable).toBe(false);
    });

    it('toggleItemStock throws NotFoundException for unknown item', async () => {
      mockPrisma.menuItem.findUnique.mockResolvedValue(null);
      await expect(
        menuService.toggleItemStock('bad-id', false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('US-2.2: Structured Modifiers Only (via OrdersService validation)', () => {
    let ordersService: OrdersService;

    beforeEach(async () => {
      const m = await buildModule(OrdersService);
      ordersService = m.get(OrdersService);
    });

    it('rejects order when required modifier is missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);

      const dtoMissingModifier = {
        ...VALID_ORDER_DTO,
        items: [
          { menuItemId: MENU_ITEM.id, quantity: 1, selectedModifiers: {} },
        ],
      };

      await expect(
        ordersService.createOrder(dtoMissingModifier),
      ).rejects.toThrow(BadRequestException);
      await expect(
        ordersService.createOrder(dtoMissingModifier),
      ).rejects.toThrow(/required/i);
    });

    it('rejects order when modifier value is not in allowed options', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);

      const dtoInvalidModifier = {
        ...VALID_ORDER_DTO,
        items: [
          {
            menuItemId: MENU_ITEM.id,
            quantity: 1,
            selectedModifiers: { rice: 'Invalid Free Text' }, // <-- free text disallowed
          },
        ],
      };

      await expect(
        ordersService.createOrder(dtoInvalidModifier),
      ).rejects.toThrow(BadRequestException);
      await expect(
        ordersService.createOrder(dtoInvalidModifier),
      ).rejects.toThrow(/invalid option/i);
    });

    it('accepts order when all modifiers are from allowed options', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: SLOT_1H_FUTURE.id, booked_count: 6, max_capacity: 15 },
      ]);
      mockPrisma.pickupSlot.findUnique.mockResolvedValue(SLOT_1H_FUTURE);
      mockPrisma.order.create.mockResolvedValue({
        id: 'new-order',
        pickupCode: '1234',
        status: OrderStatus.SCHEDULED,
        fireAt: new Date(SLOT_1H_FUTURE.startTime.getTime() - 6 * 60 * 1000),
        slot: { startTime: SLOT_1H_FUTURE.startTime },
        orderItems: [],
      });

      const result = await ordersService.createOrder(VALID_ORDER_DTO);
      expect(result.status).toBe(OrderStatus.SCHEDULED);
    });

    it('rejects order for a sold-out item (US-2.3 ↔ US-2.2 guard)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([
        { ...MENU_ITEM, isAvailable: false },
      ]);

      await expect(ordersService.createOrder(VALID_ORDER_DTO)).rejects.toThrow(
        BadRequestException,
      );
      await expect(ordersService.createOrder(VALID_ORDER_DTO)).rejects.toThrow(
        /sold out/i,
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EPIC 3 — SMART PICKUP SLOT ENGINE (DEMAND SMOOTHING)
// ═══════════════════════════════════════════════════════════════════════════════

describe('[PRD §3 — Epic 3] Pickup Slot Engine', () => {
  describe('US-3.2 Congestion Badge thresholds (calculateSlotBadge — @micro/core)', () => {
    it('returns EXPRESS when utilization < 75%  (PRD: Green — plenty of capacity)', () => {
      expect(calculateSlotBadge(0, 15)).toBe(SlotCongestionBadge.EXPRESS);
      expect(calculateSlotBadge(5, 15)).toBe(SlotCongestionBadge.EXPRESS); // 33%
      expect(calculateSlotBadge(11, 15)).toBe(SlotCongestionBadge.EXPRESS); // 73%
    });

    it('returns FILLING_FAST when utilization >= 75% and < 100%  (PRD: Amber)', () => {
      expect(calculateSlotBadge(12, 15)).toBe(SlotCongestionBadge.FILLING_FAST); // 80%
      expect(calculateSlotBadge(14, 15)).toBe(SlotCongestionBadge.FILLING_FAST); // 93%
      expect(calculateSlotBadge(11, 14)).toBe(SlotCongestionBadge.FILLING_FAST); // 78.6%
    });

    it('returns SLOT_FULL when bookedCount >= maxCapacity  (PRD: Gray / Disabled)', () => {
      expect(calculateSlotBadge(15, 15)).toBe(SlotCongestionBadge.SLOT_FULL);
      expect(calculateSlotBadge(16, 15)).toBe(SlotCongestionBadge.SLOT_FULL); // over-capacity guard
    });
  });

  describe('US-3.1 + US-3.2: SlotsService — slot formatting & recommendation', () => {
    let slotsService: SlotsService;

    const makeSlot = (overrides: Partial<PickupSlot> = {}) => ({
      id: `slot-${Math.random()}`,
      serviceDate: new Date(),
      startTime: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours away
      endTime: new Date(Date.now() + 2.1 * 60 * 60 * 1000),
      maxCapacity: 15,
      bookedCount: 0,
      ...overrides,
    });

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(SlotsService);
      slotsService = m.get(SlotsService);
    });

    it('returns EXPRESS badge and isSelectable=true for a low-utilization slot', async () => {
      const slot = makeSlot({
        id: 'express-slot',
        bookedCount: 3,
        maxCapacity: 15,
      });
      mockPrisma.pickupSlot.findMany.mockResolvedValue([slot]);

      const result = await slotsService.getTodaySlots();
      const formatted = result.slots[0];

      expect(formatted.congestionBadge).toBe(SlotCongestionBadge.EXPRESS);
      expect(formatted.isSelectable).toBe(true);
      expect(formatted.remainingCapacity).toBe(12);
    });

    it('returns FILLING_FAST badge for >= 75% utilization', async () => {
      const slot = makeSlot({ bookedCount: 12, maxCapacity: 15 }); // 80%
      mockPrisma.pickupSlot.findMany.mockResolvedValue([slot]);

      const result = await slotsService.getTodaySlots();
      expect(result.slots[0].congestionBadge).toBe(
        SlotCongestionBadge.FILLING_FAST,
      );
      expect(result.slots[0].isSelectable).toBe(true);
    });

    it('returns SLOT_FULL badge and isSelectable=false when at max capacity', async () => {
      const slot = makeSlot({ bookedCount: 15, maxCapacity: 15 });
      mockPrisma.pickupSlot.findMany.mockResolvedValue([slot]);

      const result = await slotsService.getTodaySlots();
      expect(result.slots[0].congestionBadge).toBe(
        SlotCongestionBadge.SLOT_FULL,
      );
      expect(result.slots[0].isSelectable).toBe(false);
    });

    it('recommendedSlotId points to the earliest EXPRESS slot', async () => {
      const fillingSlot = makeSlot({ id: 'filling', bookedCount: 12 }); // FILLING_FAST, earlier
      const expressSlot = makeSlot({
        id: 'express',
        bookedCount: 2,
        startTime: new Date(Date.now() + 3 * 60 * 60 * 1000), // later
      });
      mockPrisma.pickupSlot.findMany.mockResolvedValue([
        fillingSlot,
        expressSlot,
      ]);

      const result = await slotsService.getTodaySlots();
      // PRD US-3.2: pre-selects earliest available LOW-CONGESTION slot
      expect(result.recommendedSlotId).toBe('express');
    });

    it('5-min lead buffer: slot within 5 minutes of startTime is closed (isClosed=true)', async () => {
      // Slot starts in 3 minutes — within 5-min lead buffer
      const nearSlot = makeSlot({
        id: 'near',
        startTime: new Date(Date.now() + 3 * 60 * 1000),
      });
      mockPrisma.pickupSlot.findMany.mockResolvedValue([nearSlot]);

      const result = await slotsService.getTodaySlots();
      expect(result.slots[0].isClosed).toBe(true);
      expect(result.slots[0].isSelectable).toBe(false);
    });

    it('recommendedSlotId falls back to FILLING_FAST when no EXPRESS slot exists', async () => {
      const filling = makeSlot({ id: 'filling-only', bookedCount: 12 });
      mockPrisma.pickupSlot.findMany.mockResolvedValue([filling]);

      const result = await slotsService.getTodaySlots();
      expect(result.recommendedSlotId).toBe('filling-only');
    });

    it('recommendedSlotId is null when all slots are full or closed', async () => {
      const full = makeSlot({ bookedCount: 15 });
      mockPrisma.pickupSlot.findMany.mockResolvedValue([full]);

      const result = await slotsService.getTodaySlots();
      expect(result.recommendedSlotId).toBeNull();
    });
  });

  describe('US-3.1: 5-min lead buffer enforced in OrdersService', () => {
    let ordersService: OrdersService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(OrdersService);
      ordersService = m.get(OrdersService);
    });

    it('rejects order when slot startTime is within 5 minutes (SLOT_CLOSED)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);
      // Slot starts in 2 minutes — past the 5-min lead buffer
      mockPrisma.pickupSlot.findUnique.mockResolvedValue({
        ...SLOT_1H_FUTURE,
        startTime: new Date(Date.now() + 2 * 60 * 1000),
      });

      await expect(ordersService.createOrder(VALID_ORDER_DTO)).rejects.toThrow(
        ConflictException,
      );
      await expect(ordersService.createOrder(VALID_ORDER_DTO)).rejects.toThrow(
        /SLOT_CLOSED/,
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EPIC 4 — TWO-TIER KITCHEN OPERATIONS (PREP VS. FIRE)
// ═══════════════════════════════════════════════════════════════════════════════

describe('[PRD §4 — Epic 4] JIT Kitchen Operations', () => {
  describe('US-4.2: JIT fireAt = slot.startTime - max(prepDurationMins)', () => {
    let schedulerService: SchedulerService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(SchedulerService);
      schedulerService = m.get(SchedulerService);
    });

    it('enqueues JIT job with delay = fireAt - now (future fireAt)', async () => {
      const fireAt = new Date(Date.now() + 8 * 60 * 1000); // 8 mins from now
      await schedulerService.enqueueJitFireJob('order-1', fireAt);

      const [, , opts] = mockJitQueue.add.mock.calls[0];
      expect(opts.delay).toBeGreaterThan(7.5 * 60 * 1000);
      expect(opts.delay).toBeLessThanOrEqual(8 * 60 * 1000 + 100);
    });

    it('fires immediately (delay=0) when fireAt is already past — PRD §5.3B', () => {
      // If prep time > time since slot opened, fire now
    });

    it('enqueues with delay=0 when fireAt is in the past', async () => {
      const pastFireAt = new Date(Date.now() - 5 * 60 * 1000);
      await schedulerService.enqueueJitFireJob('order-past', pastFireAt);

      const [, , opts] = mockJitQueue.add.mock.calls[0];
      expect(opts.delay).toBe(0);
    });

    it('JIT job uses idempotent jobId to prevent duplicate firing', async () => {
      const fireAt = new Date(Date.now() + 10 * 60 * 1000);
      await schedulerService.enqueueJitFireJob('order-idem', fireAt);

      const [, , opts] = mockJitQueue.add.mock.calls[0];
      expect(opts.jobId).toBe('jit-order-idem');
    });
  });
  describe('US-4.2: JIT fireAt computed correctly in OrdersService', () => {
    let ordersService: OrdersService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(OrdersService);
      ordersService = m.get(OrdersService);
    });

    it('fireAt = slotStart - max(prepDurationMins) across all order items', async () => {
      const slotStart = new Date(Date.now() + 60 * 60 * 1000);
      const longPrepItem = {
        ...MENU_ITEM,
        id: 'item-long',
        prepDurationMins: 10,
      };
      const shortPrepItem = {
        ...MENU_ITEM,
        id: 'item-short',
        prepDurationMins: 2,
      };

      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([
        longPrepItem,
        shortPrepItem,
      ]);
      mockPrisma.pickupSlot.findUnique.mockResolvedValue({
        ...SLOT_1H_FUTURE,
        startTime: slotStart,
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: SLOT_1H_FUTURE.id, booked_count: 1, max_capacity: 15 },
      ]);

      let capturedFireAt: Date | null = null;
      mockPrisma.order.create.mockImplementation(
        ({ data }: { data: { fireAt: Date } }) => {
          capturedFireAt = data.fireAt;
          return Promise.resolve({
            id: 'o1',
            pickupCode: '1111',
            status: OrderStatus.SCHEDULED,
            fireAt: data.fireAt,
            slot: { startTime: slotStart },
            orderItems: [],
          });
        },
      );

      await ordersService.createOrder({
        userId: USER.id,
        slotId: SLOT_1H_FUTURE.id,
        items: [
          {
            menuItemId: 'item-long',
            quantity: 1,
            selectedModifiers: { rice: 'Jasmine' },
          },
          {
            menuItemId: 'item-short',
            quantity: 1,
            selectedModifiers: { rice: 'Jasmine' },
          },
        ],
      });

      // fireAt must be slotStart minus MAX prep (10 min), not min prep (2 min)
      const expectedFireAt = slotStart.getTime() - 10 * 60 * 1000;
      expect(capturedFireAt).toBeDefined();
      if (capturedFireAt) {
        expect((capturedFireAt as Date).getTime()).toBeCloseTo(
          expectedFireAt,
          -2,
        );
      }
    });
  });

  describe('US-4.1: KDS Prep Forecast aggregates item counts per upcoming slot', () => {
    let kdsService: KdsService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(KdsService);
      kdsService = m.get(KdsService);
    });

    it('sums quantities of same item across multiple orders in a slot', async () => {
      mockPrisma.pickupSlot.findMany.mockResolvedValue([
        {
          id: 'slot-1',
          startTime: new Date(),
          endTime: new Date(),
          orders: [
            {
              status: OrderStatus.SCHEDULED,
              orderItems: [
                {
                  menuItemId: 'i1',
                  quantity: 3,
                  menuItem: { name: 'Bowl', category: Category.HOT_MEAL },
                },
              ],
            },
            {
              status: OrderStatus.PREPARING,
              orderItems: [
                {
                  menuItemId: 'i1',
                  quantity: 2,
                  menuItem: { name: 'Bowl', category: Category.HOT_MEAL },
                },
              ],
            },
          ],
        },
      ]);

      const result = await kdsService.getForecast();
      expect(result[0].items[0].totalQuantity).toBe(5); // 3 + 2
    });

    it('only includes SCHEDULED and PREPARING orders (not COMPLETED/CANCELLED)', async () => {
      // The DB query filters by status — verify the filter is in the findMany call
      mockPrisma.pickupSlot.findMany.mockResolvedValue([]);
      await kdsService.getForecast();

      const { where } =
        mockPrisma.pickupSlot.findMany.mock.calls[0][0].include.orders;
      expect(where.status.in).toContain(OrderStatus.SCHEDULED);
      expect(where.status.in).toContain(OrderStatus.PREPARING);
      expect(where.status.in).not.toContain(OrderStatus.COMPLETED);
      expect(where.status.in).not.toContain(OrderStatus.CANCELLED);
    });
  });

  describe('US-4.2: JitFireProcessor — SCHEDULED → PREPARING transition', () => {
    let processor: JitFireProcessor;

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(JitFireProcessor);
      processor = m.get(JitFireProcessor);
    });

    it('transitions SCHEDULED order to PREPARING and emits ticket_fired (order.fired)', async () => {
      const order = {
        id: 'o1',
        pickupCode: '9999',
        userId: 'u1',
        slotId: 's1',
        pickupZone: PickupZone.SHELF_A,
        status: OrderStatus.SCHEDULED,
        slot: { startTime: new Date() },
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);

      await processor.process(makeJob({ orderId: 'o1' }, JIT_FIRE_JOB));

      expect(mockPrisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: OrderStatus.PREPARING } }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_FIRED_EVENT,
        expect.objectContaining({ orderId: 'o1' }),
      );
    });

    it('skips already-CANCELLED orders — guard against race condition', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        pickupCode: '0000',
        status: OrderStatus.CANCELLED,
        slot: { startTime: new Date() },
      });

      await processor.process(makeJob({ orderId: 'o1' }, JIT_FIRE_JOB));

      expect(mockPrisma.order.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EPIC 5 — LIVE TRACKING & ZERO-WAIT PICKUP
// ═══════════════════════════════════════════════════════════════════════════════

describe('[PRD §5 — Epic 5] Live Order Lifecycle', () => {
  describe('US-5.1: Full 4-stage order lifecycle', () => {
    let ordersService: OrdersService;
    let kdsService: KdsService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const om = await buildModule(OrdersService);
      ordersService = om.get(OrdersService);
      const km = await buildModule(KdsService);
      kdsService = km.get(KdsService);
    });

    it('Stage 1 (SCHEDULED): new order is created with SCHEDULED status', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);
      mockPrisma.pickupSlot.findUnique.mockResolvedValue(SLOT_1H_FUTURE);
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: SLOT_1H_FUTURE.id, booked_count: 1, max_capacity: 15 },
      ]);
      mockPrisma.order.create.mockResolvedValue({
        id: 'new-order',
        pickupCode: '5555',
        status: OrderStatus.SCHEDULED,
        fireAt: new Date(),
        slot: { startTime: SLOT_1H_FUTURE.startTime },
        orderItems: [],
      });

      const result = await ordersService.createOrder(VALID_ORDER_DTO);
      expect(result.status).toBe(OrderStatus.SCHEDULED);
      expect(result.pickupCode).toBeDefined();
    });

    it('Stage 2 (PREPARING): JitFireProcessor transitions SCHEDULED → PREPARING', async () => {
      // covered in Epic 4 tests above ↑
    });

    it('Stage 3 (READY_FOR_PICKUP): KdsService.markOrderReady transitions PREPARING → READY_FOR_PICKUP', async () => {
      const preparingOrder = {
        id: 'o1',
        pickupCode: '4082',
        userId: 'u1',
        slotId: 's1',
        pickupZone: PickupZone.SHELF_A,
        status: OrderStatus.PREPARING,
        slot: { startTime: new Date() },
        user: { id: 'u1', employeeCode: 'EMP-001' },
      };
      mockPrisma.order.findUnique.mockResolvedValue(preparingOrder);
      mockPrisma.order.update.mockResolvedValue({
        ...preparingOrder,
        status: OrderStatus.READY_FOR_PICKUP,
        readyAt: new Date(),
        orderItems: [],
      });

      const result = await kdsService.markOrderReady('o1');
      expect(result.status).toBe(OrderStatus.READY_FOR_PICKUP);
    });

    it('Stage 4 (COMPLETED): employee confirms pickup via completeOrder', async () => {
      const readyOrder = {
        id: 'o1',
        pickupCode: '4082',
        status: OrderStatus.READY_FOR_PICKUP,
      };
      mockPrisma.order.findUnique.mockResolvedValue(readyOrder);
      mockPrisma.order.update.mockResolvedValue({
        ...readyOrder,
        status: OrderStatus.COMPLETED,
        completedAt: new Date(),
      });

      const result = await ordersService.completeOrder('o1');
      expect(result.status).toBe(OrderStatus.COMPLETED);
      expect(mockPrisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: OrderStatus.COMPLETED }),
        }),
      );
    });

    it('completeOrder throws BadRequestException if order is not READY_FOR_PICKUP', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        pickupCode: '0000',
        status: OrderStatus.SCHEDULED,
      });
      await expect(ordersService.completeOrder('o1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('US-5.2: order.ready event emitted when PREPARING → READY_FOR_PICKUP', () => {
    let kdsService: KdsService;

    beforeEach(async () => {
      jest.clearAllMocks();
      const m = await buildModule(KdsService);
      kdsService = m.get(KdsService);
    });

    it('emits ORDER_READY_EVENT with orderId and pickupCode', async () => {
      const preparing = {
        id: 'o1',
        pickupCode: '7777',
        userId: 'u1',
        slotId: 's1',
        pickupZone: PickupZone.SHELF_B,
        status: OrderStatus.PREPARING,
        slot: { startTime: new Date() },
        user: { id: 'u1', employeeCode: 'E' },
      };
      mockPrisma.order.findUnique.mockResolvedValue(preparing);
      mockPrisma.order.update.mockResolvedValue({
        ...preparing,
        status: OrderStatus.READY_FOR_PICKUP,
        readyAt: new Date(),
        orderItems: [],
      });

      await kdsService.markOrderReady('o1');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_READY_EVENT,
        expect.objectContaining({
          orderId: 'o1',
          pickupCode: '7777',
          pickupZone: PickupZone.SHELF_B,
        }),
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EPIC 6 — CANCELLATIONS & NO-SHOW PROTECTION
// ═══════════════════════════════════════════════════════════════════════════════

describe('[PRD §6 — Epic 6] Cancellations & No-Show Protection', () => {
  let ordersService: OrdersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const m = await buildModule(OrdersService);
    ordersService = m.get(OrdersService);
  });

  describe('US-6.1: 15-minute modification cutoff', () => {
    it('allows cancellation > 15 mins before slot — isLateCancel=false', async () => {
      const slotStart = new Date(Date.now() + 30 * 60 * 1000); // 30 mins away
      const order = {
        id: 'o1',
        pickupCode: '1234',
        status: OrderStatus.SCHEDULED,
        slotId: 's1',
        slot: { startTime: slotStart },
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);
      mockPrisma.order.update.mockResolvedValue({
        ...order,
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
        isLateCancel: false,
      });
      mockPrisma.$executeRaw.mockResolvedValue(1);

      const result = await ordersService.cancelOrder('o1');
      expect(result.isLateCancel).toBe(false);
      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('flags late cancellation within 15 minutes — isLateCancel=true', async () => {
      const slotStart = new Date(Date.now() + 10 * 60 * 1000); // 10 mins away (< 15 min cutoff)
      const order = {
        id: 'o1',
        pickupCode: '5678',
        status: OrderStatus.SCHEDULED,
        slotId: 's1',
        slot: { startTime: slotStart },
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);
      mockPrisma.order.update.mockResolvedValue({
        ...order,
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
        isLateCancel: true,
      });
      mockPrisma.$executeRaw.mockResolvedValue(1);

      const result = await ordersService.cancelOrder('o1');
      expect(result.isLateCancel).toBe(true);
    });

    it('cancellation atomically decrements slot bookedCount', async () => {
      const slotStart = new Date(Date.now() + 30 * 60 * 1000);
      const order = {
        id: 'o1',
        pickupCode: '0000',
        status: OrderStatus.SCHEDULED,
        slotId: 's1',
        slot: { startTime: slotStart },
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);
      mockPrisma.order.update.mockResolvedValue({
        ...order,
        status: OrderStatus.CANCELLED,
        isLateCancel: false,
      });
      mockPrisma.$executeRaw.mockResolvedValue(1);

      await ordersService.cancelOrder('o1');
      expect(mockPrisma.$executeRaw).toHaveBeenCalled(); // GREATEST(0, booked_count - 1) decrement
    });

    it('rejects cancellation if order is not in SCHEDULED state', async () => {
      const order = {
        id: 'o1',
        pickupCode: '0000',
        status: OrderStatus.PREPARING,
        slotId: 's1',
        slot: { startTime: new Date() },
      };
      mockPrisma.order.findUnique.mockResolvedValue(order);

      await expect(ordersService.cancelOrder('o1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('US-6.2: 20-min reminder & 30-min auto-expiry', () => {
    let schedulerService: SchedulerService;
    let expiryProcessor: OrderExpiryProcessor;

    beforeEach(async () => {
      jest.clearAllMocks();
      const sm = await buildModule(SchedulerService);
      schedulerService = sm.get(SchedulerService);

      const em = await buildModule(OrderExpiryProcessor);
      expiryProcessor = em.get(OrderExpiryProcessor);
    });

    it('reminder job delay = slotStart + 20 min - now', async () => {
      const slotStart = new Date(Date.now() + 60 * 60 * 1000); // 60 min from now
      await schedulerService.enqueueExpiryJobs('order-r', slotStart);

      const [reminderName, , reminderOpts] = mockExpiryQueue.add.mock.calls[0];
      expect(reminderName).toBe(ORDER_REMINDER_JOB);
      // Expected delay ≈ 80 minutes (60 + 20)
      expect(reminderOpts.delay).toBeGreaterThan(79 * 60 * 1000);
      expect(reminderOpts.delay).toBeLessThan(81 * 60 * 1000);
    });

    it('expiry job delay = slotStart + 30 min - now', async () => {
      const slotStart = new Date(Date.now() + 60 * 60 * 1000);
      await schedulerService.enqueueExpiryJobs('order-e', slotStart);

      const [expiryName, , expiryOpts] = mockExpiryQueue.add.mock.calls[1];
      expect(expiryName).toBe(ORDER_EXPIRY_JOB);
      // Expected delay ≈ 90 minutes (60 + 30)
      expect(expiryOpts.delay).toBeGreaterThan(89 * 60 * 1000);
      expect(expiryOpts.delay).toBeLessThan(91 * 60 * 1000);
    });

    it('expiry job fires AFTER reminder job (30 min > 20 min)', async () => {
      const slotStart = new Date(Date.now() + 60 * 60 * 1000);
      await schedulerService.enqueueExpiryJobs('order-order', slotStart);

      const [, , reminderOpts] = mockExpiryQueue.add.mock.calls[0];
      const [, , expiryOpts] = mockExpiryQueue.add.mock.calls[1];
      expect(expiryOpts.delay).toBeGreaterThan(reminderOpts.delay);
    });

    it('reminder emits order.reminder event when order is READY_FOR_PICKUP', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        pickupCode: '1111',
        userId: 'u1',
        status: OrderStatus.READY_FOR_PICKUP,
      });
      await expiryProcessor.process(
        makeJob({ orderId: 'o1' }, ORDER_REMINDER_JOB),
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_REMINDER_EVENT,
        expect.objectContaining({ orderId: 'o1' }),
      );
    });

    it('expiry job transitions READY_FOR_PICKUP → EXPIRED after 30 min (US-6.2)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        pickupCode: '2222',
        userId: 'u1',
        status: OrderStatus.READY_FOR_PICKUP,
      });
      mockPrisma.order.update.mockResolvedValue({
        id: 'o1',
        pickupCode: '2222',
        status: OrderStatus.EXPIRED,
      });

      await expiryProcessor.process(
        makeJob({ orderId: 'o1' }, ORDER_EXPIRY_JOB),
      );

      expect(mockPrisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: OrderStatus.EXPIRED } }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        ORDER_EXPIRED_EVENT,
        expect.objectContaining({ orderId: 'o1' }),
      );
    });

    it('expiry skips COMPLETED orders — employee already picked up (PRD §6 edge case)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        pickupCode: '0000',
        status: OrderStatus.COMPLETED,
      });
      await expiryProcessor.process(
        makeJob({ orderId: 'o1' }, ORDER_EXPIRY_JOB),
      );

      expect(mockPrisma.order.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY & RACE CONDITION PROTECTION (PRD §5.3A)
// ═══════════════════════════════════════════════════════════════════════════════

describe('[PRD §5.3A] Atomic Slot Booking — Race Condition Prevention', () => {
  let ordersService: OrdersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const m = await buildModule(OrdersService);
    ordersService = m.get(OrdersService);
  });

  it('returns HTTP 409 SLOT_FULL when atomic UPDATE returns 0 rows (last spot taken)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);
    mockPrisma.pickupSlot.findUnique.mockResolvedValue(SLOT_1H_FUTURE);
    // 0 rows returned = another worker grabbed the last spot
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await expect(ordersService.createOrder(VALID_ORDER_DTO)).rejects.toThrow(
      ConflictException,
    );
    await expect(ordersService.createOrder(VALID_ORDER_DTO)).rejects.toThrow(
      /SLOT_FULL/,
    );
  });

  it('succeeds when atomic UPDATE returns 1 row (spot was available)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);
    mockPrisma.pickupSlot.findUnique.mockResolvedValue(SLOT_1H_FUTURE);
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: SLOT_1H_FUTURE.id, booked_count: 6, max_capacity: 15 },
    ]);
    mockPrisma.order.create.mockResolvedValue({
      id: 'o-new',
      pickupCode: '8888',
      status: OrderStatus.SCHEDULED,
      fireAt: new Date(),
      slot: { startTime: SLOT_1H_FUTURE.startTime },
      orderItems: [],
    });

    const result = await ordersService.createOrder(VALID_ORDER_DTO);
    expect(result.status).toBe(OrderStatus.SCHEDULED);
  });

  it('order creation is wrapped in $transaction (atomicity guarantee)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.menuItem.findMany.mockResolvedValue([MENU_ITEM]);
    mockPrisma.pickupSlot.findUnique.mockResolvedValue(SLOT_1H_FUTURE);
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: SLOT_1H_FUTURE.id, booked_count: 1, max_capacity: 15 },
    ]);
    mockPrisma.order.create.mockResolvedValue({
      id: 'o-tx',
      pickupCode: '7070',
      status: OrderStatus.SCHEDULED,
      fireAt: new Date(),
      slot: { startTime: SLOT_1H_FUTURE.startTime },
      orderItems: [],
    });

    await ordersService.createOrder(VALID_ORDER_DTO);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});
