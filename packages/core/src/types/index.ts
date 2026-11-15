export interface ModifierSchemaItem {
  id: string;
  name: string;
  required: boolean;
  options: string[];
}

export type SelectedModifiers = Record<string, string>;

export enum SlotCongestionBadge {
  EXPRESS = 'EXPRESS', // Green: Plenty of capacity
  FILLING_FAST = 'FILLING_FAST', // Amber: >=75% capacity
  SLOT_FULL = 'SLOT_FULL', // Gray: Capacity reached
}

export function calculateSlotBadge(
  bookedCount: number,
  maxCapacity: number,
): SlotCongestionBadge {
  if (bookedCount >= maxCapacity) {
    return SlotCongestionBadge.SLOT_FULL;
  }
  const utilization = bookedCount / maxCapacity;
  if (utilization >= 0.75) {
    return SlotCongestionBadge.FILLING_FAST;
  }
  return SlotCongestionBadge.EXPRESS;
}
