import type { Option } from '@/components/ui';

/** Retail lead source options — mirrors retail-lead-new.html. */
export const RETAIL_LEAD_SOURCES: Option[] = [
  'Customer Yard', 'Bank Partnership', 'Insurance Partnership', 'Dealer Partnership',
  'Field Sales', 'Referral', 'Social Media', 'Walk-In', 'Direct', 'Other',
].map((v) => ({ label: v, value: v }));

/** Sources that reveal the partner picker. */
export const PARTNERSHIP_SOURCES = ['Bank Partnership', 'Insurance Partnership', 'Dealer Partnership'];

export const INSTALLATION_FINANCERS: Option[] = [
  { label: 'Private', value: 'Private' },
  { label: 'Bank Financed', value: 'Bank Financed' },
];

/** Mirrors assets/vehicleCatalog.js's window.VEHICLE_CATEGORIES (finemark-ui) — keep in sync. */
export const VEHICLE_CATEGORIES: Option[] = [
  { label: 'Motor Vehicle (Car/Truck)', value: 'motor_vehicle' },
  { label: 'Motorcycle', value: 'motorcycle' },
  { label: 'Tractor', value: 'tractor' },
  { label: 'Tuktuk', value: 'tuktuk' },
  { label: 'Special Equipment', value: 'special_equipment' },
  // These three have no make/model/engine catalog — see vehicleAttributes.js on web.
  { label: 'Fabricated Body', value: 'fabricated_body' },
  { label: 'Trailers', value: 'trailers' },
  { label: 'Special Cargo', value: 'special_cargo' },
];

export const VEHICLE_COLORS: Option[] = [
  'White', 'Silver', 'Black', 'Grey', 'Blue', 'Red', 'Maroon', 'Brown', 'Beige',
  'Gold', 'Yellow', 'Orange', 'Green', 'Pearl White', 'Champagne', 'Other',
].map((v) => ({ label: v, value: v }));

/** Kenyan counties (47). */
export const KE_COUNTIES: Option[] = [
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu', 'Garissa', 'Homa Bay',
  'Isiolo', 'Kajiado', 'Kakamega', 'Kericho', 'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii',
  'Kisumu', 'Kitui', 'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera',
  'Marsabit', 'Meru', 'Migori', 'Mombasa', "Murang'a", 'Nairobi', 'Nakuru', 'Nandi',
  'Narok', 'Nyamira', 'Nyandarua', 'Nyeri', 'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River',
  'Tharaka-Nithi', 'Trans Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot',
].map((v) => ({ label: v, value: v }));
