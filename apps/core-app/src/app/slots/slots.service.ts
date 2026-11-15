import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PrismaService,
  calculateSlotBadge,
  SlotCongestionBadge,
  PickupSlot,
} from '@micro/core';

export interface FormattedSlotResponse {
  id: string;
  startTime: Date;
  endTime: Date;
  maxCapacity: number;
  bookedCount: number;
  remainingCapacity: number;
  utilizationPercentage: number;
  congestionBadge: SlotCongestionBadge;
  isClosed: boolean;
  isSelectable: boolean;
}

@Injectable()
export class SlotsService {
  constructor(private readonly prisma: PrismaService) {}

  async getTodaySlots(referenceTime: Date = new Date()) {
    const today = new Date(referenceTime);
    const serviceDate = new Date(
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
    );

    let slots = await this.prisma.pickupSlot.findMany({
      where: { serviceDate },
      orderBy: { startTime: 'asc' },
    });

    // If no slots exist for today in DB, auto-initialize standard 10-minute lunch slots (11:30 AM - 1:30 PM)
    if (slots.length === 0) {
      slots = await this.generateDefaultSlotsForDate(today);
    }

    const leadTimeMs = 5 * 60 * 1000; // 5-minute lead buffer for cooking prep
    const nowTime = referenceTime.getTime();

    let recommendedSlotId: string | null = null;

    const formattedSlots: FormattedSlotResponse[] = slots.map((slot) => {
      const isPastCutoff = nowTime > slot.startTime.getTime() - leadTimeMs;
      const isFull = slot.bookedCount >= slot.maxCapacity;
      const isClosed = isPastCutoff;
      const isSelectable = !isClosed && !isFull;

      const remainingCapacity = Math.max(0, slot.maxCapacity - slot.bookedCount);
      const utilizationPercentage = Number(
        ((slot.bookedCount / slot.maxCapacity) * 100).toFixed(1),
      );
      const congestionBadge = calculateSlotBadge(
        slot.bookedCount,
        slot.maxCapacity,
      );

      return {
        id: slot.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        maxCapacity: slot.maxCapacity,
        bookedCount: slot.bookedCount,
        remainingCapacity,
        utilizationPercentage,
        congestionBadge,
        isClosed,
        isSelectable,
      };
    });

    // Strategy 1 (Priority): Earliest selectable slot with EXPRESS status (0 min wait, ample capacity)
    const expressSlot = formattedSlots.find(
      (s) =>
        s.isSelectable && s.congestionBadge === SlotCongestionBadge.EXPRESS,
    );

    if (expressSlot) {
      recommendedSlotId = expressSlot.id;
    } else {
      // Strategy 2 (Fallback): Earliest selectable non-full slot even if FILLING_FAST
      const anySelectableSlot = formattedSlots.find((s) => s.isSelectable);
      recommendedSlotId = anySelectableSlot ? anySelectableSlot.id : null;
    }

    return {
      serviceDate: serviceDate.toISOString().split('T')[0],
      referenceTime: referenceTime.toISOString(),
      recommendedSlotId,
      totalSlots: formattedSlots.length,
      availableSlotsCount: formattedSlots.filter((s) => s.isSelectable).length,
      slots: formattedSlots,
    };
  }

  async updateSlotCapacity(
    slotId: string,
    maxCapacity: number,
  ): Promise<PickupSlot> {
    const slot = await this.prisma.pickupSlot.findUnique({
      where: { id: slotId },
    });

    if (!slot) {
      throw new NotFoundException(`Pickup slot with ID ${slotId} not found`);
    }

    return this.prisma.pickupSlot.update({
      where: { id: slotId },
      data: { maxCapacity },
    });
  }

  private async generateDefaultSlotsForDate(date: Date): Promise<PickupSlot[]> {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const serviceDate = new Date(Date.UTC(year, month, day));

    const slotConfigs = [
      { startHour: 11, startMin: 30, endHour: 11, endMin: 40 },
      { startHour: 11, startMin: 40, endHour: 11, endMin: 50 },
      { startHour: 11, startMin: 50, endHour: 12, endMin: 0 },
      { startHour: 12, startMin: 0, endHour: 12, endMin: 10 },
      { startHour: 12, startMin: 10, endHour: 12, endMin: 20 },
      { startHour: 12, startMin: 20, endHour: 12, endMin: 30 },
      { startHour: 12, startMin: 30, endHour: 12, endMin: 40 },
      { startHour: 12, startMin: 40, endHour: 12, endMin: 50 },
      { startHour: 12, startMin: 50, endHour: 13, endMin: 0 },
      { startHour: 13, startMin: 0, endHour: 13, endMin: 10 },
      { startHour: 13, startMin: 10, endHour: 13, endMin: 20 },
      { startHour: 13, startMin: 20, endHour: 13, endMin: 30 },
    ];

    const createdSlots: PickupSlot[] = [];

    for (const config of slotConfigs) {
      const startTime = new Date(
        year,
        month,
        day,
        config.startHour,
        config.startMin,
        0,
      );
      const endTime = new Date(
        year,
        month,
        day,
        config.endHour,
        config.endMin,
        0,
      );

      const slot = await this.prisma.pickupSlot.upsert({
        where: {
          serviceDate_startTime: { serviceDate, startTime },
        },
        update: {},
        create: {
          serviceDate,
          startTime,
          endTime,
          maxCapacity: 15,
          bookedCount: 0,
        },
      });
      createdSlots.push(slot);
    }

    return createdSlots;
  }
}
