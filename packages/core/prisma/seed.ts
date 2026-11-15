import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  Category,
  PickupZone,
  Role,
} from '@prisma/client';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/quickbite?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting QuickBite database seeding...');

  // 1. Seed Users (SSO Personas)
  const usersData = [
    {
      employeeCode: 'EMP-HEAD-01',
      fullName: 'Chef Marco Rossi',
      email: 'marco.rossi@company.internal',
      role: Role.HEAD_OF_KITCHEN,
    },
    {
      employeeCode: 'EMP-COOK-01',
      fullName: 'Sarah Jenkins',
      email: 'sarah.jenkins@company.internal',
      role: Role.KITCHEN_STAFF,
    },
    {
      employeeCode: 'EMP-USER-101',
      fullName: 'Alice Chen',
      email: 'alice.chen@company.internal',
      role: Role.EMPLOYEE,
    },
    {
      employeeCode: 'EMP-USER-102',
      fullName: 'Bob Smith',
      email: 'bob.smith@company.internal',
      role: Role.EMPLOYEE,
    },
    {
      employeeCode: 'EMP-USER-103',
      fullName: 'Charlie Kim',
      email: 'charlie.kim@company.internal',
      role: Role.EMPLOYEE,
    },
  ];

  for (const user of usersData) {
    await prisma.user.upsert({
      where: { employeeCode: user.employeeCode },
      update: { fullName: user.fullName, role: user.role },
      create: user,
    });
  }
  console.log(`✅ Seeded ${usersData.length} users (SSO personas)`);

  // 2. Seed Menu Items (with strictly predefined modifier schemas)
  const menuItemsData = [
    {
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
          options: ['Steamed Jasmine Rice', 'Organic Brown Rice'],
        },
        {
          id: 'spice_level',
          name: 'Spice Level',
          required: true,
          options: ['No Spice', 'Mild Kick', 'Spicy'],
        },
      ],
    },
    {
      name: 'Spicy Tofu & Kimchi Grain Bowl',
      category: Category.HOT_MEAL,
      prepDurationMins: 5,
      pickupZone: PickupZone.SHELF_A,
      isAvailable: true,
      modifiersSchema: [
        {
          id: 'grain_choice',
          name: 'Grain Base',
          required: true,
          options: ['Brown Rice', 'Quinoa Blend'],
        },
        {
          id: 'kimchi_portion',
          name: 'Kimchi Portion',
          required: true,
          options: ['Regular', 'Extra Kimchi'],
        },
      ],
    },
    {
      name: 'Crispy Chicken Katsu Sando',
      category: Category.HOT_MEAL,
      prepDurationMins: 7,
      pickupZone: PickupZone.SHELF_B,
      isAvailable: true,
      modifiersSchema: [
        {
          id: 'sauce_style',
          name: 'Sauce',
          required: true,
          options: ['Classic Tonkatsu Sauce', 'Spicy Kewpie Mayo', 'Sauce On Side'],
        },
      ],
    },
    {
      name: 'Artisan Iced Latte',
      category: Category.COLD_DRINK,
      prepDurationMins: 2,
      pickupZone: PickupZone.DRINK_COUNTER,
      isAvailable: true,
      modifiersSchema: [
        {
          id: 'milk_type',
          name: 'Milk Choice',
          required: true,
          options: ['Whole Milk', 'Oat Milk', 'Almond Milk'],
        },
        {
          id: 'sweetness',
          name: 'Sweetness',
          required: true,
          options: ['0% Unsweetened', '50% Less Sweet', '100% Normal'],
        },
        {
          id: 'ice_level',
          name: 'Ice Level',
          required: true,
          options: ['Normal Ice', 'Less Ice'],
        },
      ],
    },
    {
      name: 'Nitro Cold Brew Coffee',
      category: Category.COLD_DRINK,
      prepDurationMins: 1,
      pickupZone: PickupZone.DRINK_COUNTER,
      isAvailable: true,
      modifiersSchema: [
        {
          id: 'ice_level',
          name: 'Ice Level',
          required: true,
          options: ['Normal Ice', 'Less Ice'],
        },
      ],
    },
    {
      name: 'Sparkling Yuzu Citrus Cooler',
      category: Category.COLD_DRINK,
      prepDurationMins: 2,
      pickupZone: PickupZone.DRINK_COUNTER,
      isAvailable: true,
      modifiersSchema: [
        {
          id: 'sweetness',
          name: 'Sweetness',
          required: true,
          options: ['Regular Sweet', 'Light Sweet'],
        },
      ],
    },
    {
      name: 'Fresh Berry & Greek Yogurt Cup',
      category: Category.SNACK,
      prepDurationMins: 1,
      pickupZone: PickupZone.SHELF_B,
      isAvailable: true,
      modifiersSchema: [],
    },
    {
      name: 'Dark Chocolate Sea Salt Brownie',
      category: Category.SNACK,
      prepDurationMins: 1,
      pickupZone: PickupZone.SHELF_B,
      isAvailable: true,
      modifiersSchema: [],
    },
  ];

  for (const item of menuItemsData) {
    const existing = await prisma.menuItem.findFirst({
      where: { name: item.name },
    });
    if (existing) {
      await prisma.menuItem.update({
        where: { id: existing.id },
        data: item,
      });
    } else {
      await prisma.menuItem.create({ data: item });
    }
  }
  console.log(`✅ Seeded ${menuItemsData.length} menu items`);

  // 3. Seed Today's 10-Minute Capped Pickup Slots (11:30 AM - 1:30 PM)
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const day = today.getDate();

  const slotTimes = [
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

  const serviceDate = new Date(Date.UTC(year, month, day));

  for (const slot of slotTimes) {
    const startTime = new Date(year, month, day, slot.startHour, slot.startMin, 0);
    const endTime = new Date(year, month, day, slot.endHour, slot.endMin, 0);

    await prisma.pickupSlot.upsert({
      where: {
        serviceDate_startTime: {
          serviceDate,
          startTime,
        },
      },
      update: {
        endTime,
        maxCapacity: 15,
      },
      create: {
        serviceDate,
        startTime,
        endTime,
        maxCapacity: 15,
        bookedCount: 0,
      },
    });
  }
  console.log(`✅ Seeded ${slotTimes.length} pickup slots (10-minute intervals) for today`);

  console.log('🎉 Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
