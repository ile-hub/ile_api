import 'reflect-metadata';
import { compatibilityReasons, discoveryReasons } from './discovery';
import type {
  PublicLandlordProfile,
  PublicRenterProfile,
} from './profile.types';
const renter = {
  preferredLocation: 'Edinburgh',
  budgetMin: 500,
  budgetMax: 1500,
  targetMoveDate: '2026-11-01',
  tenancyLengthMonths: 12,
  householdSize: 2,
  householdPreferences: [],
} as unknown as PublicRenterProfile;
const landlord = {
  properties: [
    {
      city: 'Edinburgh',
      currency: 'GBP',
      rentAmount: 1250,
      propertyRules: [],
      details: {
        availableFrom: '2026-10-30',
        minTenancyMonths: 6,
        permittedOccupants: 2,
      },
    },
  ],
} as unknown as PublicLandlordProfile;
test('suggestions explain practical fit without scores or evidence inputs', () => {
  expect(compatibilityReasons(renter, landlord)).toHaveLength(5);
  expect(
    compatibilityReasons({ ...renter, budgetMax: 1000 }, landlord),
  ).toEqual([]);
  expect(
    compatibilityReasons({ ...renter, targetMoveDate: '2026-10-01' }, landlord),
  ).toEqual([]);
  expect(
    compatibilityReasons({ ...renter, householdSize: 3 }, landlord),
  ).toEqual([]);
  expect(
    compatibilityReasons({ ...renter, tenancyLengthMonths: 3 }, landlord),
  ).toEqual([]);
  expect(
    compatibilityReasons({ ...renter, preferredLocation: 'Glasgow' }, landlord),
  ).toEqual([]);
});
test('missing compatibility inputs produce no invented recommendations and ARCS does not affect results', () => {
  expect(
    compatibilityReasons(
      { ...renter, evidenceSummary: [] },
      {
        ...landlord,
        arcsPreferences: { priorityOrder: [], evidencePreferences: {} },
      },
    ),
  ).toEqual(compatibilityReasons(renter, landlord));
  expect(
    compatibilityReasons(
      {
        preferredLocation: null,
        budgetMin: null,
        budgetMax: null,
        targetMoveDate: null,
        tenancyLengthMonths: null,
        householdSize: null,
        householdPreferences: [],
      } as unknown as PublicRenterProfile,
      landlord,
    ),
  ).toEqual([]);
});

test('landlord reasons describe renter preferences without inventing landlord preferences', () => {
  expect(
    discoveryReasons(
      { ...landlord, kind: 'landlord' },
      { ...renter, kind: 'renter' },
    ),
  ).toContain('In the renter’s preferred area');
});
