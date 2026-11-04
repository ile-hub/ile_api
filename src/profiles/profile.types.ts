import type { ArcsPreferences } from '../landlords/arcs-preferences.dto';
import type { PublicProperty } from '../properties/properties.service';
export interface EvidenceStrandSummary {
  pillar: 'affordability' | 'reliability' | 'community' | 'stability';
  status: 'Information added' | 'Document uploaded' | 'Not provided';
  categories: {
    catalogueId: string | null;
    label: string;
    status: 'Information added' | 'Document uploaded';
  }[];
}
export type CheckStatus =
  'unverified' | 'pending' | 'verified' | 'failed' | 'expired';
export interface Verification {
  identityStatus: CheckStatus;
  photoStatus: 'unverified' | 'pending' | 'verified';
  mode: 'real' | 'demo';
}
export interface PublicProfileBase {
  id: string;
  displayName: string;
  bio: string | null;
  photoUrl: string | null;
  memberSince: string;
}
export interface PublicRenterProfile extends PublicProfileBase {
  kind: 'renter';
  evidenceSummary: EvidenceStrandSummary[];
  personalStory: string | null;
  preferredLocation: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  targetMoveDate: string | null;
  tenancyLengthMonths: number | null;
  householdSize: number | null;
  householdType: 'single' | 'couple' | 'family' | 'sharers' | null;
  householdPreferences: ('pet_friendly' | 'smoke_free' | 'sharing')[];
  verification: Verification;
}
export interface PublicLandlordProfile extends PublicProfileBase {
  kind: 'landlord';
  arcsPreferences: ArcsPreferences;
  properties: PublicProperty[];
  companyName: string | null;
  landlordType: 'individual' | 'company' | 'agent' | null;
  lettingExperienceYears: number | null;
  numberOfProperties: number | null;
  locationsCovered: string[];
  communicationStyle: string | null;
  lettingApproach: string | null;
  tenantExpectations: string | null;
  tenancySuccess: string | null;
  verification: Verification & { registrationStatus: CheckStatus };
}
export type PublicProfile = PublicRenterProfile | PublicLandlordProfile;
export type OwnRenterProfile = PublicRenterProfile & {
  currentLocation: string | null;
  discoverable: boolean;
  updatedAt: string;
};
export type OwnLandlordProfile = PublicLandlordProfile & {
  registrationNumbers: string[];
  registrationDetails: string | null;
  discoverable: boolean;
  updatedAt: string;
};
export type OwnProfile = OwnRenterProfile | OwnLandlordProfile;
