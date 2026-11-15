import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SlotsService, FormattedSlotResponse } from './slots.service';
import { PrismaService, SlotCongestionBadge } from '@micro/core';

describe('SlotsService', () => {
  let service: SlotsService;

  const today = new Date('2026-11-15T11:00:00.000Z');
  const serviceDate = new Date(Date.UTC(2026, 10, 15));

  const mockSlots = [
    {
      id: 'slot-1130',
      serviceDate,
      startTime: new Date('2026-11-15T11:30:00.000Z'),
      endTime: new Date('2026-11-15T11:40:00.000Z'),
      maxCapacity: 15,
      bookedCount: 2, // 13.3% -> EXPRESS
      createdAt: today,
      updatedAt: today,
    },
    {
      id: 'slot-1140',
      serviceDate,
      startTime: new Date('2026-11-15T11:40:00.000Z'),
      endTime: new Date('2026-11-15T11:50:00.000Z'),
      maxCapacity: 15,
      bookedCount: 12, // 80% -> FILLING_FAST
      createdAt: today,
      updatedAt: today,
    },
    {
      id: 'slot-1150',
      serviceDate,
      startTime: new Date('2026-11-15T11:50:00.000Z'),
      endTime: new Date('2026-11-15T12:00:00.000Z'),
      maxCapacity: 15,
      bookedCount: 15, // 100% -> SLOT_FULL
      createdAt: today,
      updatedAt: today,
    },
    {
      id: 'slot-1200',
      serviceDate,
      startTime: new Date('2026-11-15T12:00:00.000Z'),
      endTime: new Date('2026-11-15T12:10:00.000Z'),
      maxCapacity: 15,
      bookedCount: 3, // 20% -> EXPRESS
      createdAt: today,
      updatedAt: today,
    },
  ];

  const mockPrismaService = {
    pickupSlot: {
      findMany: jest.fn().mockResolvedValue(mockSlots),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        const found = mockSlots.find((s) => s.id === where.id);
        return Promise.resolve(found || null);
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const found = mockSlots.find((s) => s.id === where.id);
        return Promise.resolve({ ...found, ...data });
      }),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlotsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<SlotsService>(SlotsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTodaySlots at 11:00 AM (all future slots)', () => {
    it('should calculate congestion badges and recommend earliest EXPRESS slot', async () => {
      const referenceTime = new Date('2026-11-15T11:00:00.000Z');
      const result = await service.getTodaySlots(referenceTime);

      expect(result.totalSlots).toBe(4);
      expect(result.availableSlotsCount).toBe(3); // 3 slots not full and not closed
      expect(result.recommendedSlotId).toBe('slot-1130'); // Earliest EXPRESS slot

      // Check slot-1130: 2/15 booked -> EXPRESS
      const slot1130 = result.slots.find(
        (s: FormattedSlotResponse) => s.id === 'slot-1130',
      );
      expect(slot1130?.congestionBadge).toBe(SlotCongestionBadge.EXPRESS);
      expect(slot1130?.remainingCapacity).toBe(13);
      expect(slot1130?.isSelectable).toBe(true);

      // Check slot-1140: 12/15 booked -> FILLING_FAST
      const slot1140 = result.slots.find(
        (s: FormattedSlotResponse) => s.id === 'slot-1140',
      );
      expect(slot1140?.congestionBadge).toBe(SlotCongestionBadge.FILLING_FAST);
      expect(slot1140?.remainingCapacity).toBe(3);
      expect(slot1140?.isSelectable).toBe(true);

      // Check slot-1150: 15/15 booked -> SLOT_FULL
      const slot1150 = result.slots.find(
        (s: FormattedSlotResponse) => s.id === 'slot-1150',
      );
      expect(slot1150?.congestionBadge).toBe(SlotCongestionBadge.SLOT_FULL);
      expect(slot1150?.remainingCapacity).toBe(0);
      expect(slot1150?.isSelectable).toBe(false);
    });
  });

  describe('Edge case: Ordering at 11:28 AM (11:30 slot buffer expired)', () => {
    it('should close 11:30 slot within 5 min cutoff and shift recommended slot to 12:00 PM EXPRESS', async () => {
      // 11:28 AM: 11:30 AM is only 2 minutes away, so 5-min prep buffer makes it closed
      const referenceTime = new Date('2026-11-15T11:28:00.000Z');
      const result = await service.getTodaySlots(referenceTime);

      const slot1130 = result.slots.find(
        (s: FormattedSlotResponse) => s.id === 'slot-1130',
      );
      expect(slot1130?.isClosed).toBe(true);
      expect(slot1130?.isSelectable).toBe(false);

      // slot-1140 is open but FILLING_FAST; slot-1200 is open and EXPRESS
      // Since earliest EXPRESS priority applies, slot-1200 is recommended!
      expect(result.recommendedSlotId).toBe('slot-1200');
    });
  });

  describe('updateSlotCapacity', () => {
    it('should update maxCapacity for a slot', async () => {
      const updated = await service.updateSlotCapacity('slot-1130', 20);
      expect(updated.maxCapacity).toBe(20);
    });

    it('should throw NotFoundException if slot does not exist', async () => {
      await expect(
        service.updateSlotCapacity('non-existent-slot', 20),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
