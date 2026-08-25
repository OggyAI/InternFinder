/**
 * Bundled suburb gazetteer for greater Melbourne.
 *
 * WHY THIS EXISTS: neither Adzuna nor Jooble guarantees coordinates on a
 * listing. Adzuna usually has them; Jooble returns a free-text location like
 * "Werribee, VIC" and nothing else. Rather than take on an external geocoder
 * — Nominatim caps you at 1 req/sec and wants a custom User-Agent, which is a
 * rate limit to babysit for a problem that is really just a lookup table — we
 * resolve suburb names locally.
 *
 * ACCURACY: these are approximate suburb centroids to ~3-4 decimal places,
 * good to a few hundred metres. Against a 50 km radius that error is noise.
 * They are NOT survey-grade and should not be used for anything finer.
 *
 * COVERAGE: metro Melbourne, weighted toward the western suburbs near the
 * search centre, plus regional centres that fall OUTSIDE the radius (Ballarat,
 * Bendigo, Traralgon) so "Victorian but too far" listings get correctly
 * rejected rather than silently kept.
 *
 * A NOTE ON THE GEOMETRY, because it is counter-intuitive: the search centre
 * is in the far west, so a 50 km radius from Hoppers Crossing is NOT the same
 * thing as "Melbourne". It reaches Geelong (42 km) and Bacchus Marsh (33 km),
 * but excludes Lilydale (59 km), Berwick (59 km) and Cranbourne (57 km).
 * Eastern-suburb roles get dropped on distance even though they are
 * unambiguously Melbourne jobs. Widen filters.radius_km if that is not wanted.
 *
 * A suburb missing from this table is not an error — it resolves to
 * distance = null, and filters.keep_unknown_location decides what happens
 * next. To improve coverage, add rows here; no other code changes.
 */

export interface SuburbEntry {
  name: string;
  /** Postcodes that map to this locality. Used as a secondary lookup key. */
  postcodes: string[];
  lat: number;
  lng: number;
  state: string;
}

export const MELBOURNE_SUBURBS: SuburbEntry[] = [
  // --- Inner Melbourne -----------------------------------------------------
  { name: 'Melbourne', postcodes: ['3000', '3004'], lat: -37.8136, lng: 144.9631, state: 'VIC' },
  { name: 'Melbourne CBD', postcodes: ['3000'], lat: -37.8136, lng: 144.9631, state: 'VIC' },
  { name: 'Southbank', postcodes: ['3006'], lat: -37.8236, lng: 144.9647, state: 'VIC' },
  { name: 'Docklands', postcodes: ['3008'], lat: -37.8150, lng: 144.9450, state: 'VIC' },
  { name: 'West Melbourne', postcodes: ['3003'], lat: -37.8100, lng: 144.9400, state: 'VIC' },
  { name: 'North Melbourne', postcodes: ['3051'], lat: -37.8000, lng: 144.9433, state: 'VIC' },
  { name: 'Carlton', postcodes: ['3053'], lat: -37.8000, lng: 144.9667, state: 'VIC' },
  { name: 'Parkville', postcodes: ['3052'], lat: -37.7833, lng: 144.9500, state: 'VIC' },
  { name: 'Fitzroy', postcodes: ['3065'], lat: -37.7983, lng: 144.9783, state: 'VIC' },
  { name: 'Collingwood', postcodes: ['3066'], lat: -37.8000, lng: 144.9833, state: 'VIC' },
  { name: 'Abbotsford', postcodes: ['3067'], lat: -37.8033, lng: 144.9967, state: 'VIC' },
  { name: 'Richmond', postcodes: ['3121'], lat: -37.8183, lng: 145.0000, state: 'VIC' },
  { name: 'South Melbourne', postcodes: ['3205'], lat: -37.8333, lng: 144.9600, state: 'VIC' },
  { name: 'Port Melbourne', postcodes: ['3207'], lat: -37.8400, lng: 144.9400, state: 'VIC' },
  { name: 'South Yarra', postcodes: ['3141'], lat: -37.8383, lng: 144.9933, state: 'VIC' },
  { name: 'Prahran', postcodes: ['3181'], lat: -37.8483, lng: 144.9917, state: 'VIC' },
  { name: 'St Kilda', postcodes: ['3182'], lat: -37.8683, lng: 144.9800, state: 'VIC' },
  { name: 'Albert Park', postcodes: ['3206'], lat: -37.8417, lng: 144.9550, state: 'VIC' },

  // --- Western suburbs (closest to the search centre) ----------------------
  { name: 'Hoppers Crossing', postcodes: ['3029'], lat: -37.8829, lng: 144.7003, state: 'VIC' },
  { name: 'Tarneit', postcodes: ['3029'], lat: -37.8333, lng: 144.6667, state: 'VIC' },
  { name: 'Truganina', postcodes: ['3029'], lat: -37.8167, lng: 144.7333, state: 'VIC' },
  { name: 'Werribee', postcodes: ['3030'], lat: -37.9000, lng: 144.6614, state: 'VIC' },
  { name: 'Werribee South', postcodes: ['3030'], lat: -37.9667, lng: 144.7167, state: 'VIC' },
  { name: 'Wyndham Vale', postcodes: ['3024'], lat: -37.8833, lng: 144.6167, state: 'VIC' },
  { name: 'Manor Lakes', postcodes: ['3024'], lat: -37.8833, lng: 144.5833, state: 'VIC' },
  { name: 'Mambourin', postcodes: ['3024'], lat: -37.9167, lng: 144.6000, state: 'VIC' },
  { name: 'Point Cook', postcodes: ['3030'], lat: -37.9167, lng: 144.7500, state: 'VIC' },
  { name: 'Williams Landing', postcodes: ['3027'], lat: -37.8667, lng: 144.7417, state: 'VIC' },
  { name: 'Seabrook', postcodes: ['3028'], lat: -37.8833, lng: 144.7667, state: 'VIC' },
  { name: 'Altona Meadows', postcodes: ['3028'], lat: -37.8833, lng: 144.7833, state: 'VIC' },
  { name: 'Altona', postcodes: ['3018'], lat: -37.8683, lng: 144.8300, state: 'VIC' },
  { name: 'Altona North', postcodes: ['3025'], lat: -37.8383, lng: 144.8467, state: 'VIC' },
  { name: 'Laverton', postcodes: ['3028'], lat: -37.8667, lng: 144.7667, state: 'VIC' },
  { name: 'Laverton North', postcodes: ['3026'], lat: -37.8333, lng: 144.7833, state: 'VIC' },
  { name: 'Brooklyn', postcodes: ['3012'], lat: -37.8167, lng: 144.8417, state: 'VIC' },
  { name: 'Tottenham', postcodes: ['3012'], lat: -37.7983, lng: 144.8617, state: 'VIC' },
  { name: 'West Footscray', postcodes: ['3012'], lat: -37.7967, lng: 144.8750, state: 'VIC' },
  { name: 'Footscray', postcodes: ['3011'], lat: -37.7997, lng: 144.8997, state: 'VIC' },
  { name: 'Seddon', postcodes: ['3011'], lat: -37.8067, lng: 144.8917, state: 'VIC' },
  { name: 'Kingsville', postcodes: ['3012'], lat: -37.8000, lng: 144.8750, state: 'VIC' },
  { name: 'Yarraville', postcodes: ['3013'], lat: -37.8167, lng: 144.8917, state: 'VIC' },
  { name: 'Spotswood', postcodes: ['3015'], lat: -37.8300, lng: 144.8833, state: 'VIC' },
  { name: 'Newport', postcodes: ['3015'], lat: -37.8433, lng: 144.8833, state: 'VIC' },
  { name: 'Williamstown', postcodes: ['3016'], lat: -37.8600, lng: 144.8950, state: 'VIC' },
  { name: 'Maribyrnong', postcodes: ['3032'], lat: -37.7717, lng: 144.8867, state: 'VIC' },
  { name: 'Braybrook', postcodes: ['3019'], lat: -37.7833, lng: 144.8583, state: 'VIC' },
  { name: 'Sunshine', postcodes: ['3020'], lat: -37.7883, lng: 144.8317, state: 'VIC' },
  { name: 'Sunshine West', postcodes: ['3020'], lat: -37.8000, lng: 144.8167, state: 'VIC' },
  { name: 'Albion', postcodes: ['3020'], lat: -37.7767, lng: 144.8183, state: 'VIC' },
  { name: 'Ardeer', postcodes: ['3022'], lat: -37.7833, lng: 144.8000, state: 'VIC' },
  { name: 'Deer Park', postcodes: ['3023'], lat: -37.7667, lng: 144.7667, state: 'VIC' },
  { name: 'Caroline Springs', postcodes: ['3023'], lat: -37.7433, lng: 144.7383, state: 'VIC' },
  { name: 'Burnside', postcodes: ['3023'], lat: -37.7583, lng: 144.7500, state: 'VIC' },
  { name: 'St Albans', postcodes: ['3021'], lat: -37.7450, lng: 144.8000, state: 'VIC' },
  { name: 'Kealba', postcodes: ['3021'], lat: -37.7367, lng: 144.8117, state: 'VIC' },
  { name: 'Keilor', postcodes: ['3036'], lat: -37.7167, lng: 144.8333, state: 'VIC' },
  { name: 'Keilor Downs', postcodes: ['3038'], lat: -37.7250, lng: 144.8000, state: 'VIC' },
  { name: 'Taylors Lakes', postcodes: ['3038'], lat: -37.7000, lng: 144.7833, state: 'VIC' },
  { name: 'Sydenham', postcodes: ['3037'], lat: -37.7000, lng: 144.7667, state: 'VIC' },
  { name: 'Hillside', postcodes: ['3037'], lat: -37.6917, lng: 144.7417, state: 'VIC' },
  { name: 'Rockbank', postcodes: ['3335'], lat: -37.7333, lng: 144.6500, state: 'VIC' },
  { name: 'Aintree', postcodes: ['3336'], lat: -37.7167, lng: 144.6167, state: 'VIC' },
  { name: 'Melton', postcodes: ['3337'], lat: -37.6833, lng: 144.5833, state: 'VIC' },
  { name: 'Melton South', postcodes: ['3338'], lat: -37.7000, lng: 144.5750, state: 'VIC' },
  { name: 'Bacchus Marsh', postcodes: ['3340'], lat: -37.6767, lng: 144.4383, state: 'VIC' },
  { name: 'Little River', postcodes: ['3211'], lat: -37.9833, lng: 144.5167, state: 'VIC' },

  // --- North-western -------------------------------------------------------
  { name: 'Essendon', postcodes: ['3040'], lat: -37.7500, lng: 144.9167, state: 'VIC' },
  { name: 'Moonee Ponds', postcodes: ['3039'], lat: -37.7650, lng: 144.9200, state: 'VIC' },
  { name: 'Ascot Vale', postcodes: ['3032'], lat: -37.7783, lng: 144.9200, state: 'VIC' },
  { name: 'Niddrie', postcodes: ['3042'], lat: -37.7417, lng: 144.8833, state: 'VIC' },
  { name: 'Airport West', postcodes: ['3042'], lat: -37.7167, lng: 144.8833, state: 'VIC' },
  { name: 'Tullamarine', postcodes: ['3043'], lat: -37.7000, lng: 144.8833, state: 'VIC' },
  { name: 'Melbourne Airport', postcodes: ['3045'], lat: -37.6733, lng: 144.8433, state: 'VIC' },
  { name: 'Broadmeadows', postcodes: ['3047'], lat: -37.6800, lng: 144.9200, state: 'VIC' },
  { name: 'Glenroy', postcodes: ['3046'], lat: -37.7050, lng: 144.9200, state: 'VIC' },
  { name: 'Pascoe Vale', postcodes: ['3044'], lat: -37.7250, lng: 144.9333, state: 'VIC' },
  { name: 'Coburg', postcodes: ['3058'], lat: -37.7433, lng: 144.9633, state: 'VIC' },
  { name: 'Brunswick', postcodes: ['3056'], lat: -37.7667, lng: 144.9600, state: 'VIC' },
  { name: 'Craigieburn', postcodes: ['3064'], lat: -37.6000, lng: 144.9333, state: 'VIC' },
  { name: 'Roxburgh Park', postcodes: ['3064'], lat: -37.6333, lng: 144.9333, state: 'VIC' },
  { name: 'Sunbury', postcodes: ['3429'], lat: -37.5783, lng: 144.7267, state: 'VIC' },
  { name: 'Diggers Rest', postcodes: ['3427'], lat: -37.6250, lng: 144.7167, state: 'VIC' },
  { name: 'Gisborne', postcodes: ['3437'], lat: -37.4900, lng: 144.5900, state: 'VIC' },

  // --- Northern ------------------------------------------------------------
  { name: 'Northcote', postcodes: ['3070'], lat: -37.7700, lng: 145.0000, state: 'VIC' },
  { name: 'Preston', postcodes: ['3072'], lat: -37.7417, lng: 145.0083, state: 'VIC' },
  { name: 'Reservoir', postcodes: ['3073'], lat: -37.7167, lng: 145.0000, state: 'VIC' },
  { name: 'Thomastown', postcodes: ['3074'], lat: -37.6833, lng: 145.0167, state: 'VIC' },
  { name: 'Epping', postcodes: ['3076'], lat: -37.6500, lng: 145.0333, state: 'VIC' },
  { name: 'South Morang', postcodes: ['3752'], lat: -37.6500, lng: 145.0833, state: 'VIC' },
  { name: 'Mill Park', postcodes: ['3082'], lat: -37.6667, lng: 145.0667, state: 'VIC' },
  { name: 'Bundoora', postcodes: ['3083'], lat: -37.7000, lng: 145.0667, state: 'VIC' },
  { name: 'Greensborough', postcodes: ['3088'], lat: -37.7033, lng: 145.1017, state: 'VIC' },
  { name: 'Heidelberg', postcodes: ['3084'], lat: -37.7500, lng: 145.0667, state: 'VIC' },
  { name: 'Ivanhoe', postcodes: ['3079'], lat: -37.7667, lng: 145.0417, state: 'VIC' },
  { name: 'Eltham', postcodes: ['3095'], lat: -37.7167, lng: 145.1500, state: 'VIC' },

  // --- Eastern -------------------------------------------------------------
  { name: 'Kew', postcodes: ['3101'], lat: -37.8067, lng: 145.0333, state: 'VIC' },
  { name: 'Hawthorn', postcodes: ['3122'], lat: -37.8217, lng: 145.0333, state: 'VIC' },
  { name: 'Camberwell', postcodes: ['3124'], lat: -37.8333, lng: 145.0667, state: 'VIC' },
  { name: 'Balwyn', postcodes: ['3103'], lat: -37.8100, lng: 145.0800, state: 'VIC' },
  { name: 'Doncaster', postcodes: ['3108'], lat: -37.7867, lng: 145.1250, state: 'VIC' },
  { name: 'Templestowe', postcodes: ['3106'], lat: -37.7583, lng: 145.1333, state: 'VIC' },
  { name: 'Box Hill', postcodes: ['3128'], lat: -37.8183, lng: 145.1233, state: 'VIC' },
  { name: 'Burwood', postcodes: ['3125'], lat: -37.8500, lng: 145.1167, state: 'VIC' },
  { name: 'Blackburn', postcodes: ['3130'], lat: -37.8200, lng: 145.1500, state: 'VIC' },
  { name: 'Nunawading', postcodes: ['3131'], lat: -37.8200, lng: 145.1700, state: 'VIC' },
  { name: 'Mitcham', postcodes: ['3132'], lat: -37.8167, lng: 145.1917, state: 'VIC' },
  { name: 'Vermont', postcodes: ['3133'], lat: -37.8333, lng: 145.1917, state: 'VIC' },
  { name: 'Ringwood', postcodes: ['3134'], lat: -37.8150, lng: 145.2300, state: 'VIC' },
  { name: 'Croydon', postcodes: ['3136'], lat: -37.7967, lng: 145.2833, state: 'VIC' },
  { name: 'Lilydale', postcodes: ['3140'], lat: -37.7550, lng: 145.3483, state: 'VIC' },
  { name: 'Bayswater', postcodes: ['3153'], lat: -37.8433, lng: 145.2683, state: 'VIC' },
  { name: 'Wantirna', postcodes: ['3152'], lat: -37.8583, lng: 145.2167, state: 'VIC' },
  { name: 'Knoxfield', postcodes: ['3180'], lat: -37.8833, lng: 145.2500, state: 'VIC' },
  { name: 'Rowville', postcodes: ['3178'], lat: -37.9250, lng: 145.2333, state: 'VIC' },
  { name: 'Scoresby', postcodes: ['3179'], lat: -37.9000, lng: 145.2333, state: 'VIC' },

  // --- South-eastern -------------------------------------------------------
  { name: 'Malvern', postcodes: ['3144'], lat: -37.8583, lng: 145.0283, state: 'VIC' },
  { name: 'Chadstone', postcodes: ['3148'], lat: -37.8867, lng: 145.0850, state: 'VIC' },
  { name: 'Oakleigh', postcodes: ['3166'], lat: -37.9000, lng: 145.0900, state: 'VIC' },
  { name: 'Mount Waverley', postcodes: ['3149'], lat: -37.8750, lng: 145.1283, state: 'VIC' },
  { name: 'Glen Waverley', postcodes: ['3150'], lat: -37.8783, lng: 145.1650, state: 'VIC' },
  { name: 'Notting Hill', postcodes: ['3168'], lat: -37.9000, lng: 145.1333, state: 'VIC' },
  { name: 'Clayton', postcodes: ['3168'], lat: -37.9167, lng: 145.1167, state: 'VIC' },
  { name: 'Mulgrave', postcodes: ['3170'], lat: -37.9200, lng: 145.1700, state: 'VIC' },
  { name: 'Springvale', postcodes: ['3171'], lat: -37.9500, lng: 145.1500, state: 'VIC' },
  { name: 'Noble Park', postcodes: ['3174'], lat: -37.9667, lng: 145.1750, state: 'VIC' },
  { name: 'Dandenong', postcodes: ['3175'], lat: -37.9833, lng: 145.2167, state: 'VIC' },
  { name: 'Narre Warren', postcodes: ['3805'], lat: -38.0333, lng: 145.3000, state: 'VIC' },
  { name: 'Berwick', postcodes: ['3806'], lat: -38.0333, lng: 145.3500, state: 'VIC' },
  { name: 'Pakenham', postcodes: ['3810'], lat: -38.0700, lng: 145.4850, state: 'VIC' },
  { name: 'Cranbourne', postcodes: ['3977'], lat: -38.1000, lng: 145.2833, state: 'VIC' },

  // --- Bayside / southern --------------------------------------------------
  { name: 'Brighton', postcodes: ['3186'], lat: -37.9067, lng: 144.9950, state: 'VIC' },
  { name: 'Bentleigh', postcodes: ['3204'], lat: -37.9183, lng: 145.0367, state: 'VIC' },
  { name: 'Moorabbin', postcodes: ['3189'], lat: -37.9383, lng: 145.0417, state: 'VIC' },
  { name: 'Cheltenham', postcodes: ['3192'], lat: -37.9633, lng: 145.0567, state: 'VIC' },
  { name: 'Mordialloc', postcodes: ['3195'], lat: -38.0050, lng: 145.0867, state: 'VIC' },
  { name: 'Frankston', postcodes: ['3199'], lat: -38.1417, lng: 145.1233, state: 'VIC' },

  // --- Regional Victoria and interstate ------------------------------------
  // Geelong and Lara sit INSIDE a 50 km radius of Hoppers Crossing (42 km and
  // 30 km). Ballarat, Bendigo and Traralgon are outside it.
  { name: 'Lara', postcodes: ['3212'], lat: -38.0250, lng: 144.4083, state: 'VIC' },
  { name: 'Geelong', postcodes: ['3220'], lat: -38.1499, lng: 144.3617, state: 'VIC' },
  { name: 'Ballarat', postcodes: ['3350'], lat: -37.5622, lng: 143.8503, state: 'VIC' },
  { name: 'Bendigo', postcodes: ['3550'], lat: -36.7570, lng: 144.2794, state: 'VIC' },
  { name: 'Traralgon', postcodes: ['3844'], lat: -38.1953, lng: 146.5406, state: 'VIC' },
  { name: 'Sydney', postcodes: ['2000'], lat: -33.8688, lng: 151.2093, state: 'NSW' },
  { name: 'Brisbane', postcodes: ['4000'], lat: -27.4698, lng: 153.0251, state: 'QLD' },
  { name: 'Perth', postcodes: ['6000'], lat: -31.9523, lng: 115.8613, state: 'WA' },
  { name: 'Adelaide', postcodes: ['5000'], lat: -34.9285, lng: 138.6007, state: 'SA' },
  { name: 'Canberra', postcodes: ['2600'], lat: -35.2809, lng: 149.1300, state: 'ACT' },
  { name: 'Hobart', postcodes: ['7000'], lat: -42.8821, lng: 147.3272, state: 'TAS' },
  { name: 'Darwin', postcodes: ['0800'], lat: -12.4634, lng: 130.8456, state: 'NT' },
];

/**
 * Alternate spellings that appear in job ads but are not localities in their
 * own right. Mapped onto a canonical entry above.
 */
export const SUBURB_ALIASES: Record<string, string> = {
  'melbourne vic': 'Melbourne',
  'melbourne cbd': 'Melbourne',
  'cbd & inner suburbs': 'Melbourne',
  'melbourne city': 'Melbourne',
  'greater melbourne': 'Melbourne',
  'melbourne, australia': 'Melbourne',
  'western suburbs': 'Sunshine',
  'melbourne western suburbs': 'Sunshine',
  'northern suburbs': 'Preston',
  'eastern suburbs': 'Box Hill',
  'south eastern suburbs': 'Dandenong',
  'bayside & south eastern suburbs': 'Moorabbin',
  'geelong & great ocean road': 'Geelong',
  'st albans vic': 'St Albans',
};
