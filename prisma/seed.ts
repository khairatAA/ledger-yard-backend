import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingCycle,
  LeaseStatus,
  PrismaClient,
} from '../generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

const ids = {
  organization: '10000000-0000-4000-8000-000000000001',
  tenant: '20000000-0000-4000-8000-000000000001',
  property: '30000000-0000-4000-8000-000000000001',
  unit: '40000000-0000-4000-8000-000000000001',
  lease: '50000000-0000-4000-8000-000000000001',
};

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

async function main() {
  const today = startOfUtcDay(new Date());
  const leaseEndDate = addYears(today, 1);

  const organization = await prisma.organization.upsert({
    where: {
      id: ids.organization,
    },
    update: {
      name: 'Demo Property Management',
      status: 'ACTIVE',
    },
    create: {
      id: ids.organization,
      name: 'Demo Property Management',
      status: 'ACTIVE',
    },
  });

  const tenant = await prisma.user.upsert({
    where: {
      id: ids.tenant,
    },
    update: {
      email: 'tenant@ledgeryard.test',
      fullName: 'Demo Tenant',
    },
    create: {
      id: ids.tenant,
      email: 'tenant@ledgeryard.test',
      fullName: 'Demo Tenant',
    },
  });

  const property = await prisma.property.upsert({
    where: {
      id: ids.property,
    },
    update: {
      name: 'Victoria Court',
      propertyType: 'RESIDENTIAL',
      timezone: 'Africa/Lagos',
    },
    create: {
      id: ids.property,
      organizationId: organization.id,
      name: 'Victoria Court',
      propertyType: 'RESIDENTIAL',
      timezone: 'Africa/Lagos',
    },
  });

  const unit = await prisma.unit.upsert({
    where: {
      id: ids.unit,
    },
    update: {
      name: 'Apartment A1',
      status: 'OCCUPIED',
    },
    create: {
      id: ids.unit,
      propertyId: property.id,
      name: 'Apartment A1',

      // ₦250,000 stored in kobo.
      baseRentMinor: BigInt(25_000_000),
      securityDepositMinor: BigInt(25_000_000),

      currencyCode: 'NGN',
      billingCycle: BillingCycle.MONTHLY,
      status: 'OCCUPIED',
    },
  });

  const lease = await prisma.lease.upsert({
    where: {
      id: ids.lease,
    },

    /*
     * Do not reset nextInvoiceDate when the seed runs again.
     * The invoice processor may already have advanced it.
     */
    update: {
      status: LeaseStatus.ACTIVE,
    },

    create: {
      id: ids.lease,
      organizationId: organization.id,
      unitId: unit.id,
      tenantId: tenant.id,
      startDate: today,
      endDate: leaseEndDate,
      rentAmountMinor: BigInt(25_000_000),
      securityDepositMinor: BigInt(25_000_000),
      currencyCode: 'NGN',
      billingCycle: BillingCycle.MONTHLY,
      nextInvoiceDate: today,
      status: LeaseStatus.ACTIVE,
    },
  });

  console.log('Seed completed successfully');
  console.log({
    organizationId: organization.id,
    tenantId: tenant.id,
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    nextInvoiceDate: lease.nextInvoiceDate,
  });
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
