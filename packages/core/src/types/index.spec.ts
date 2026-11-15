import { calculateSlotBadge, SlotCongestionBadge } from './index';

describe('Slot Congestion Calculator (Queuing Protection)', () => {
  const maxCapacity = 15;

  it('should return EXPRESS badge when utilization is below 75%', () => {
    expect(calculateSlotBadge(0, maxCapacity)).toBe(SlotCongestionBadge.EXPRESS);
    expect(calculateSlotBadge(5, maxCapacity)).toBe(SlotCongestionBadge.EXPRESS);
    expect(calculateSlotBadge(11, maxCapacity)).toBe(SlotCongestionBadge.EXPRESS); // 11/15 = 73.3%
  });

  it('should return FILLING_FAST badge when utilization is 75% or higher but below 100%', () => {
    expect(calculateSlotBadge(12, maxCapacity)).toBe(SlotCongestionBadge.FILLING_FAST); // 12/15 = 80% (Queuing Theory warning zone)
    expect(calculateSlotBadge(14, maxCapacity)).toBe(SlotCongestionBadge.FILLING_FAST); // 14/15 = 93.3%
  });

  it('should return SLOT_FULL badge when capacity is reached or exceeded', () => {
    expect(calculateSlotBadge(15, maxCapacity)).toBe(SlotCongestionBadge.SLOT_FULL);
    expect(calculateSlotBadge(16, maxCapacity)).toBe(SlotCongestionBadge.SLOT_FULL);
  });
});
