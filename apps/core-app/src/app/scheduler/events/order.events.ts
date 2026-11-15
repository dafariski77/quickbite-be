import { PickupZone } from '@micro/core';

export class OrderFiredEvent {
  constructor(
    public readonly orderId: string,
    public readonly pickupCode: string,
    public readonly userId: string,
    public readonly slotId: string,
    public readonly pickupZone: PickupZone,
  ) {}
}

export class OrderReminderEvent {
  constructor(
    public readonly orderId: string,
    public readonly pickupCode: string,
    public readonly userId: string,
  ) {}
}

export class OrderExpiredEvent {
  constructor(
    public readonly orderId: string,
    public readonly pickupCode: string,
  ) {}
}

export class OrderReadyEvent {
  constructor(
    public readonly orderId: string,
    public readonly pickupCode: string,
    public readonly userId: string,
    public readonly pickupZone: PickupZone,
  ) {}
}

// Event name constants (used by @OnEvent decorators)
export const ORDER_FIRED_EVENT = 'order.fired';
export const ORDER_REMINDER_EVENT = 'order.reminder';
export const ORDER_EXPIRED_EVENT = 'order.expired';
export const ORDER_READY_EVENT = 'order.ready';
