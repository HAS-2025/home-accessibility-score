// server.js - Updated with Accessible Features scoring
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Store for caching results
const cache = new Map();

// Helper function for EPC image conversion
async function convertImageToBase64(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: 10000
        });
        return Buffer.from(response.data, 'binary').toString('base64');
    } catch (error) {
        throw new Error(`Failed to fetch image: ${error.message}`);
    }
}

// 🔧 LAZY LOAD EPC Vision Extractor with correct model
let EPCVisionExtractor = null;
const getEPCExtractor = () => {
    if (!EPCVisionExtractor && process.env.CLAUDE_API_KEY) {
        try {
            console.log('📡 Loading EPC Vision Extractor on demand...');
            const { EPCVisionExtractor: ExtractorClass } = require('./epc-vision-extractor');
            EPCVisionExtractor = ExtractorClass;
            console.log('✅ EPC Vision Extractor loaded');
            
            // Create instance with updated configuration
            const instance = new EPCVisionExtractor(process.env.CLAUDE_API_KEY);
            
            // Override the model if the extractor has outdated model
            if (instance.model && instance.model.includes('claude-3-sonnet-20240229')) {
                console.log('🔄 Updating EPC extractor to use newer model...');
                instance.model = 'claude-3-5-sonnet-20241022';
            }
            
            return instance;
        } catch (error) {
            console.warn('⚠️ EPC Vision Extractor not available:', error.message);
            EPCVisionExtractor = false;
        }
    }
    return EPCVisionExtractor ? new EPCVisionExtractor(process.env.CLAUDE_API_KEY) : null;
};

// Claude API configuration
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// FIXED: Enhanced Accessible Features Detection Logic
function calculateAccessibleFeaturesScore(propertyData) {
    let score = 0;
    const features = [];
    
    // Extract relevant text for analysis - FIXED variable references
    const description = (propertyData.description || '').toLowerCase();
    const title = (propertyData.title || '').toLowerCase();
    const propertyFeatures = (propertyData.features || []).join(' ').toLowerCase();
    const fullText = `${title} ${description} ${propertyFeatures}`.toLowerCase();
    
    console.log('🏠 Analyzing accessible features for property...');
    console.log('📝 Full text being analyzed (first 500 chars):', fullText.substring(0, 500));
    
    // FIXED: Enhanced single floor detection in calculateAccessibleFeaturesScore()
// Replace the lateral living section (around lines 115-135) with this:

// 1. LATERAL LIVING / SINGLE FLOOR PROPERTIES (Ground level only)
const lateralLivingKeywords = [
    'lateral living', 'single floor', 'all on one level', 'one level living',
    'ground floor flat', 'ground floor apartment', 'ground floor maisonette',
    'bungalow', 'dormer bungalow', 'detached bungalow', 'semi-detached bungalow',
    'chalet bungalow', 'ranch style', 'single storey', 'single story',
    'all on one floor', 'single level', 'one storey', 'one story'
];

// Exclusions for properties above ground level
const upperFloorExclusions = [
    'first floor', 'second floor', 'third floor', 'fourth floor', 'fifth floor',
    'upper floor', 'top floor', 'penthouse', 'mezzanine',
    'apartment on floor', 'flat on floor', 'level 1', 'level 2', 'level 3',
    'floor 1', 'floor 2', 'floor 3'
];

// NEW: Multi-level indicators (properties that have multiple internal levels)
const multiLevelIndicators = [
    'upstairs', 'upstairs bedroom', 'upstairs bathroom', 'upstairs room',
    'first floor bedroom', 'first floor bathroom', 'bedroom upstairs',
    'bathroom upstairs', 'stairs to', 'staircase', 'stairway',
    'upper level', 'upper floor', 'loft room', 'loft bedroom',
    'attic room', 'converted loft', 'stairs leading to',
    'two storey', 'two story', 'duplex', 'split level',
    'mezzanine level', 'gallery level', 'raised area'
];

const hasLateralLiving = lateralLivingKeywords.some(keyword => fullText.includes(keyword));
const isUpperFloor = upperFloorExclusions.some(exclusion => fullText.includes(exclusion));
const hasMultipleLevels = multiLevelIndicators.some(indicator => fullText.includes(indicator));

let isSingleFloorProperty = false;
if (hasLateralLiving && !isUpperFloor && !hasMultipleLevels) {
    score += 1;
    features.push('Lateral living/single floor (ground level)');
    isSingleFloorProperty = true;
    console.log('✓ Found lateral living/single floor property (ground level)');
} else if (hasLateralLiving && hasMultipleLevels) {
    console.log('✗ Property has lateral living keywords but also has multiple levels - NOT awarding lateral living point');
    console.log('  Multi-level indicators found:', multiLevelIndicators.filter(indicator => fullText.includes(indicator)));
} else if (hasLateralLiving && isUpperFloor) {
    console.log('✗ Property has lateral living keywords but is on upper floor - NOT awarding lateral living point');
}
    
    // ENHANCED: Downstairs bedroom and bathroom detection
// Replace the existing downstairs bedroom and bathroom sections with this:

// 2. DOWNSTAIRS BEDROOM - Enhanced Logic for Multi-level Properties
const downstairsBedroomKeywords = [
    'downstairs bedroom', 'ground floor bedroom', 'bedroom downstairs',
    'bedroom on ground floor', 'ground floor bed', 'downstairs bed',
    'bedroom ground level', 'ground floor comprises', 'ground floor has',
    'ground floor features', 'ground floor includes'
];

// Enhanced patterns for multi-level properties
const groundFloorBedroomPatterns = [
    /ground floor.*?bedroom/gi,
    /ground floor.*?bed/gi,
    /bedroom.*?ground floor/gi,
    /comprises.*?bedroom/gi,
    /includes.*?bedroom/gi,
    /features.*?bedroom/gi,
    /ground floor.*?double bedroom/gi,
    /ground floor.*?single bedroom/gi,
    /ground floor.*?master bedroom/gi
];

let hasDownstairsBedroom = downstairsBedroomKeywords.some(keyword => fullText.includes(keyword));

// If no explicit keyword found, check patterns for ground floor bedroom mentions
if (!hasDownstairsBedroom) {
    hasDownstairsBedroom = groundFloorBedroomPatterns.some(pattern => pattern.test(fullText));
    if (hasDownstairsBedroom) {
        console.log('✓ Found downstairs bedroom via pattern matching');
    }
}

// If it's a single floor property with bedrooms, automatically count as downstairs bedroom
if (!hasDownstairsBedroom && isSingleFloorProperty) {
    const hasBedroomMention = fullText.includes('bedroom') || fullText.includes('bed');
    if (hasBedroomMention) {
        hasDownstairsBedroom = true;
        console.log('✓ Inferred downstairs bedroom from single floor property with bedrooms');
    }
}

if (hasDownstairsBedroom) {
    score += 1;
    features.push('Downstairs bedroom');
    console.log('✓ Found downstairs bedroom');
}

// 3. DOWNSTAIRS BATHROOM - Enhanced Logic for Multi-level Properties
const downstairsBathroomKeywords = [
    'downstairs bathroom', 'ground floor bathroom', 'bathroom downstairs',
    'bathroom on ground floor', 'ground floor wc', 'downstairs wc',
    'downstairs toilet', 'ground floor toilet', 'downstairs shower room',
    'ground floor shower room', 'ground floor cloakroom', 'downstairs cloakroom'
];

// Enhanced patterns for multi-level properties
const groundFloorBathroomPatterns = [
    /ground floor.*?bathroom/gi,
    /ground floor.*?wc/gi,
    /ground floor.*?toilet/gi,
    /ground floor.*?shower/gi,
    /ground floor.*?cloakroom/gi,
    /bathroom.*?ground floor/gi,
    /comprises.*?bathroom/gi,
    /includes.*?bathroom/gi,
    /features.*?bathroom/gi
];

let hasDownstairsBathroom = downstairsBathroomKeywords.some(keyword => fullText.includes(keyword));

// If no explicit keyword found, check patterns for ground floor bathroom mentions
if (!hasDownstairsBathroom) {
    hasDownstairsBathroom = groundFloorBathroomPatterns.some(pattern => pattern.test(fullText));
    if (hasDownstairsBathroom) {
        console.log('✓ Found downstairs bathroom via pattern matching');
    }
}

// If it's a single floor property with bathroom facilities, automatically count
if (!hasDownstairsBathroom && isSingleFloorProperty) {
    const hasBathroomMention = fullText.includes('bathroom') || fullText.includes('shower') || 
                              fullText.includes('toilet') || fullText.includes('wc') || 
                              fullText.includes('en suite') || fullText.includes('ensuite');
    if (hasBathroomMention) {
        hasDownstairsBathroom = true;
        console.log('✓ Inferred downstairs bathroom from single floor property with bathroom facilities');
    }
}

if (hasDownstairsBathroom) {
    score += 1;
    features.push('Downstairs bathroom/WC');
    console.log('✓ Found downstairs bathroom/WC');
}
    
    // 4. LEVEL AND/OR RAMP ACCESS - Enhanced Keywords
    const levelAccessKeywords = [
        'level access', 'step-free access', 'step free access', 'no steps',
        'wheelchair accessible', 'ramp access', 'ramped access', 'access ramp',
        'disabled access', 'mobility access', 'easy access', 'ground level access',
        'flat access', 'level entry', 'step-free entry', 'barrier-free access',
        'accessible entrance', 'level entrance', 'no step access'
    ];
    
    const hasLevelAccess = levelAccessKeywords.some(keyword => fullText.includes(keyword));
    
    if (hasLevelAccess) {
        score += 1;
        features.push('Level/ramp access');
        console.log('✓ Found level/ramp access');
    }
    
    // 5. OFF-STREET OR PRIVATE PARKING - Enhanced Detection
    const parkingKeywords = [
        'private parking', 'off-street parking', 'off street parking',
        'designated parking', 'allocated parking', 'residents parking',
        'driveway', 'garage', 'car port', 'carport', 'parking space',
        'parking bay', 'secure parking', 'covered parking', 'underground parking',
        'gated parking', 'private garage', 'double garage', 'single garage',
        'own parking', 'dedicated parking', 'assigned parking', 'ev charger',
        'electric vehicle charger', 'charging point'
    ];
    
    // Exclusions for on-street parking
    const parkingExclusions = [
        'on-street parking', 'on street parking', 'street parking',
        'roadside parking', 'permit parking', 'resident permit only'
    ];
    
    const hasPrivateParking = parkingKeywords.some(keyword => fullText.includes(keyword));
    const hasOnStreetOnly = parkingExclusions.some(exclusion => fullText.includes(exclusion)) && !hasPrivateParking;
    
    if (hasPrivateParking && !hasOnStreetOnly) {
        score += 1;
        features.push('Off-street/private parking');
        console.log('✓ Found off-street/private parking');
    }
    
    console.log(`🏠 Accessible Features Score: ${score}/5`);
    console.log('✅ Features found:', features);
    console.log('🔍 Single floor property detected:', isSingleFloorProperty);
    
    return {
        score: score,
        maxScore: 5,
        features: features,
        percentage: Math.round((score / 5) * 100),
        details: {
            lateralLiving: hasLateralLiving && !isUpperFloor,
            downstairsBedroom: hasDownstairsBedroom,
            downstairsBathroom: hasDownstairsBathroom,
            levelAccess: hasLevelAccess,
            privateParking: hasPrivateParking && !hasOnStreetOnly,
            isSingleFloorProperty: isSingleFloorProperty
        }
    };
}

// Try to access dedicated floorplan page
async function tryFloorplanURL(propertyId) {
    try {
        const floorplanURL = `https://www.rightmove.co.uk/properties/${propertyId}#/floorplan?activePlan=1&channel=RES_BUY`;
        
        console.log('Trying floorplan URL:', floorplanURL);
        
        const response = await axios.get(floorplanURL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 8000 // Reduced timeout
        });

        const $ = cheerio.load(response.data);
        
        const floorplanImages = [];
        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && (src.includes('floorplan') || src.includes('plan') || 
                       $(img).attr('alt')?.toLowerCase().includes('floorplan'))) {
                floorplanImages.push(src);
            }
        });
        
        console.log(`Found ${floorplanImages.length} floorplans on dedicated page`);
        return floorplanImages.length > 0 ? floorplanImages[0] : null;
        
    } catch (error) {
        console.log('Floorplan URL not accessible:', error.message);
        return null;
    }
}

// Enhanced coordinate extraction using Geocoding API as fallback
async function getPropertyCoordinates(address, existingCoords) {
    if (existingCoords && existingCoords.lat && existingCoords.lng) {
        console.log('Using coordinates from property scraping:', existingCoords);
        return existingCoords;
    }
    
    if (address && address !== 'Address not found') {
        try {
            console.log('Using Geocoding API for address:', address);
            
            const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?` +
                `address=${encodeURIComponent(address)}&` +
                `region=uk&` +
                `key=${process.env.GOOGLE_MAPS_API_KEY}`;
            
            const response = await axios.get(geocodeUrl, { timeout: 8000 });
            
            if (response.data.results && response.data.results.length > 0) {
                const location = response.data.results[0].geometry.location;
                console.log('Geocoding API found coordinates:', location);
                return {
                    lat: location.lat,
                    lng: location.lng
                };
            }
        } catch (error) {
            console.error('Geocoding API error:', error.message);
        }
    }
    
    console.log('No coordinates available for property');
    return null;
}

// ✅ ENHANCED GP SEARCH with detailed coordinate logging
async function findNearestGPs(lat, lng) {
    try {
        console.log(`Finding GP surgeries near ${lat}, ${lng} using Places API (New)`);
        console.log(`🗺️ Property location: https://www.google.com/maps?q=${lat},${lng}`);
        
        const requestBody = {
            includedTypes: ["doctor"],
            maxResultCount: 20,
            locationRestriction: {
                circle: {
                    center: { latitude: lat, longitude: lng },
                    radius: 2000.0
                }
            },
            rankPreference: "DISTANCE",
            languageCode: "en-GB",
            regionCode: "GB"
        };
        
        const response = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.id,places.businessStatus,places.websiteUri'
                },
                timeout: 8000
            }
        );
        
        console.log('Places API response received');
        console.log('Total places found:', response.data.places?.length || 0);

        if (response.data.places && response.data.places.length > 0) {
            // ✅ KEEP FULL ENHANCED FILTERING but add coordinate logging
            const gps = response.data.places
                .filter(place => {
                    const name = place.displayName?.text?.toLowerCase() || '';
                    const address = (place.formattedAddress || '').toLowerCase();
                    const types = place.types || [];
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        console.log(`Skipping closed place: ${name}`);
                        return false;
                    }
                    
                    // FULL exclusions list
                    const isDefinitelyNotGP = (
                        name.includes('ear wax') || name.includes('earwax') || name.includes('chiropody') ||
                        name.includes('podiatry') || name.includes('foot care') || name.includes('hearing') ||
                        name.includes('tree surgery') || name.includes('tree service') || name.includes('landscaping') ||
                        name.includes('fertility') || name.includes('astrology') || name.includes('acupuncture') ||
                        name.includes('chiropractor') || name.includes('physiotherapy') || name.includes('physio') ||
                        name.includes('osteopath') || name.includes('counselling') || name.includes('therapy') ||
                        name.includes('beauty') || name.includes('aesthetic') || name.includes('cosmetic') ||
                        name.includes('laser') || name.includes('skin care') || name.includes('botox') ||
                        name.includes('massage') || name.includes('pharmacy') || name.includes('dentist') ||
                        name.includes('dental') || name.includes('optician') || name.includes('eye care') ||
                        name.includes('vet') || name.includes('veterinary') || name.includes('care home') ||
                        name.includes('nursing home') || name.includes('mental health') || name.includes('royal united hospital') ||
                        name.includes('ruh') || name.includes('university hospital') || name.includes('podiatrist') || 
                        name.includes('spa') || name.includes('spamedica') || 
                        name.includes('hair restoration') || name.includes('hair transplant') ||
                        name.includes('physico') || name.includes('physiotherapy') ||

                        // NOW CHECK ADDRESS TOO:
                        address.includes('spamedica') || address.includes('spa') ||
                        address.includes('aesthetic') || address.includes('cosmetic') ||
                        address.includes('hair restoration') || address.includes('beauty') ||
                        address.includes('ear wax') || address.includes('earwax') || address.includes('chiropody') ||
                        address.includes('podiatry') || address.includes('podiatrist') || address.includes('foot care') || address.includes('hearing') ||
                        address.includes('tree surgery') || address.includes('tree service') || address.includes('landscaping') ||
                        address.includes('fertility') || address.includes('astrology') || address.includes('acupuncture') ||
                        address.includes('chiropractor') || address.includes('physiotherapy') || address.includes('physio') ||
                        address.includes('osteopath') || address.includes('counselling') || address.includes('therapy') ||
                        address.includes('laser') || address.includes('skin care') || address.includes('botox') ||
                        address.includes('massage') || address.includes('pharmacy') || address.includes('dentist') ||
                        address.includes('dental') || address.includes('optician') || address.includes('eye care') ||
                        address.includes('vet') || address.includes('veterinary') || address.includes('care home') ||
                        address.includes('nursing home') || address.includes('mental health') ||
                        address.includes('hair transplant') || address.includes('physico')
                    
                    );
                    
                    if (isDefinitelyNotGP) {
                        console.log(`${name}: Excluded (definitely not GP)`);
                        return false;
                    }
                    
                    // FULL positive identification
                    const isLikelyGPSurgery = (
                        name.includes('gp surgery') || name.includes('doctors surgery') ||
                        name.includes('medical centre') || name.includes('medical center') ||
                        name.includes('health centre') || name.includes('health center') ||
                        name.includes('family practice') || name.includes('primary care') ||
                        name.includes('group practice') || name.includes('health practice') ||
                        (name.includes('medical practice') && name.includes('dr ')) ||
                        (name.includes('surgery') && !name.includes('tree') && !name.includes('plastic') &&
                         !name.includes('cosmetic') && !name.includes('laser') && !name.includes('aesthetic') &&
                         (name.includes('dr ') || name.includes('practice') || name.includes('medical') ||
                          name.includes('health') || name.includes('grosvenor') || name.includes('pulteney') ||
                          name.includes('batheaston') || name.includes('bath'))) ||
                        (name.includes('medical') && (name.includes('centre') || name.includes('center')) &&
                         !name.includes('specialist') && !name.includes('private')) ||
                        (name.includes('dr ') && (name.includes('surgery') || name.includes('practice') ||
                         name.includes('medical') || name.includes('health'))) ||
                        (types.includes('doctor') && !name.includes('specialist') &&
                         !name.includes('private') && !name.includes('clinic'))
                    );
                    
                    const isValid = isLikelyGPSurgery;
                    console.log(`${name}: GP=${isLikelyGPSurgery}, Final=${isValid}`);
                    
                    return isValid;
                })
                .map(place => {
                    const gpLat = place.location?.latitude;
                    const gpLng = place.location?.longitude;
                    
                    // Calculate straight-line distance for verification
                    const straightLineDistance = calculateStraightLineDistance(lat, lng, gpLat, gpLng);
                    
                    const gpInfo = {
                        name: place.displayName?.text || 'Medical Practice',
                        address: place.formattedAddress || 'Address not available',
                        location: { lat: gpLat, lng: gpLng },
                        rating: place.rating || null,
                        placeId: place.id,
                        businessStatus: place.businessStatus,
                        website: place.websiteUri || null,
                        straightLineDistance: straightLineDistance
                    };
                    
                    // 📍 LOG DETAILED COORDINATE INFO
                    console.log(`📍 GP: ${gpInfo.name}`);
                    console.log(`   Address: ${gpInfo.address}`);
                    console.log(`   Coordinates: ${gpLat}, ${gpLng}`);
                    console.log(`   Google Maps: https://www.google.com/maps?q=${gpLat},${gpLng}`);
                    console.log(`   Straight-line distance: ${straightLineDistance.toFixed(2)} km`);
                    console.log(`   ---`);
                    
                    return gpInfo;
                })
                .slice(0, 5);
            
            console.log(`Found ${gps.length} valid GP surgeries`);
            
            if (gps.length > 0) {
                return gps;
            }
        }

        // Fallback searches...
        console.log('No GPs found with strict search, trying broader criteria...');
        return await findGPsBroadSearch(lat, lng);
        
    } catch (error) {
        console.error('Places API (New) error:', error.response?.data || error.message);
        console.log('Falling back to legacy Places API...');
        return await findGPsLegacyAPI(lat, lng);
    }
}

// Helper function to calculate straight-line distance
function calculateStraightLineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}
// Helper function to get postcode from coordinates
function getPostcodeFromCoordinates(coordinates) {
    // This would require a reverse geocoding API call
    // For now, return null - we can implement this separately
    return null;
}
// Helper function to get score rating text
function getScoreRating(score) {
    if (score >= 4.5) return 'Excellent';
    if (score >= 3.5) return 'Good';
    if (score >= 2.5) return 'Fair';
    return 'Poor';
}

// Broader search using multiple place types
async function findGPsBroadSearch(lat, lng) {
    try {
        const requestBody = {
            includedTypes: ["doctor", "health", "hospital"],
            maxResultCount: 30,
            locationRestriction: {
                circle: { center: { latitude: lat, longitude: lng }, radius: 3000.0 }
            },
            rankPreference: "DISTANCE",
            languageCode: "en-GB",
            regionCode: "GB"
        };
        
        const response = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.id'
                },
                timeout: 8000
            }
        );
        
        if (response.data.places && response.data.places.length > 0) {
            const gps = response.data.places
                .filter(place => {
                    const name = place.displayName?.text?.toLowerCase() || '';
                    return (
                        (name.includes('surgery') || name.includes('medical') || 
                         name.includes('gp') || name.includes('doctors')) &&
                        !name.includes('hospital') &&
                        !name.includes('pharmacy')
                    );
                })
                .map(place => ({
                    name: place.displayName?.text || 'Medical Facility',
                    address: place.formattedAddress || 'Address not available',
                    location: {
                        lat: place.location?.latitude,
                        lng: place.location?.lng
                    },
                    rating: place.rating || null,
                    placeId: place.id
                }))
                .slice(0, 3);
            
            console.log(`Broad search found ${gps.length} medical facilities`);
            return gps;
        }
        
        return [];
    } catch (error) {
        console.error('Broad Places search failed:', error.message);
        return [];
    }
}

// Legacy API fallback
async function findGPsLegacyAPI(lat, lng) {
    try {
        console.log('Using legacy Places API as final fallback...');
        
        const legacyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?` +
            `location=${lat},${lng}&radius=2000&type=doctor&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(legacyUrl, { timeout: 8000 });
        
        if (response.data.results && response.data.results.length > 0) {
            const gps = response.data.results
                .filter(place => {
                    const name = place.name.toLowerCase();
                    return (
                        name.includes('surgery') || name.includes('medical') ||
                        name.includes('gp') || name.includes('doctors')
                    );
                })
                .map(place => ({
                    name: place.name,
                    address: place.vicinity || 'Address not available',
                    location: {
                        lat: place.geometry.location.lat,
                        lng: place.geometry.location.lng
                    },
                    rating: place.rating || null,
                    placeId: place.place_id
                }))
                .slice(0, 3);
            
            console.log(`Legacy API found ${gps.length} GP surgeries`);
            return gps;
        }
        
        return [];
    } catch (error) {
        console.error('Legacy Places API error:', error.message);
        return [];
    }
}

// ✅ FULL WALKING ROUTE ANALYSIS - Keep detailed analysis
async function analyzeWalkingRoute(fromLat, fromLng, toLat, toLng, gpName) {
    try {
        console.log(`Calculating precise walking route to ${gpName} using Directions API`);
        
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${fromLat},${fromLng}&` +
            `destination=${toLat},${toLng}&` +
            `mode=walking&` +
            `units=metric&` +
            `region=uk&` +
            `language=en-GB&` +
            `key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(directionsUrl, {
            timeout: 12000 // Slightly reduced
        });
        
        if (response.data.routes && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            const leg = route.legs[0];
            
            console.log('Directions API returned route data:');
            console.log('- Distance:', leg.distance.text);
            console.log('- Duration:', leg.duration.text);
            console.log('- Steps:', leg.steps.length);
            
            const steps = leg.steps;
            const routeWarnings = [];
            const routeFeatures = {
                hasStairs: false,
                hasSteepIncline: false,
                crossesBusyRoads: false,
                hasTrafficLights: false
            };
            
            steps.forEach(step => {
                const instruction = step.html_instructions.toLowerCase();
                
                if (instruction.includes('stairs') || instruction.includes('steps')) {
                    routeWarnings.push('Route includes stairs');
                    routeFeatures.hasStairs = true;
                }
                if (instruction.includes('steep') || instruction.includes('hill') || instruction.includes('incline')) {
                    routeWarnings.push('Steep incline detected');
                    routeFeatures.hasSteepIncline = true;
                }
                if (instruction.includes('main') || instruction.includes('busy') || instruction.includes('major') || instruction.includes('a road') || instruction.includes('dual carriageway')) {
                    routeWarnings.push('Crosses busy roads');
                    routeFeatures.crossesBusyRoads = true;
                }
                if (instruction.includes('traffic lights') || instruction.includes('crossing') || instruction.includes('pedestrian crossing')) {
                    routeFeatures.hasTrafficLights = true;
                }
            });
            
            const durationMinutes = Math.ceil(leg.duration.value / 60);
            
            const result = {
                distance: leg.distance.text,
                duration: leg.duration.text,
                durationMinutes: durationMinutes,
                durationSeconds: leg.duration.value,
                distanceMeters: leg.distance.value,
                routeWarnings: [...new Set(routeWarnings)],
                routeFeatures: routeFeatures,
                accessibilityScore: calculateRouteAccessibilityScore(routeFeatures, durationMinutes),
                accessibilityNotes: generateAccessibilityNotes(durationMinutes, routeFeatures, routeWarnings),
                gpName: gpName,
                steps: steps.length
            };
            
            console.log(`Walking route analysis complete:`, {
                time: result.duration,
                distance: result.distance,
                accessibility: result.accessibilityScore
            });
            
            return result;
        }
        
        return null;
        
    } catch (error) {
        console.error('Directions API error:', error.response?.data || error.message);
        return null;
    }
}

// Calculate route accessibility score
function calculateRouteAccessibilityScore(features, durationMinutes) {
    let score = 5;
    
    if (features.hasStairs) score -= 2;
    if (features.hasSteepIncline) score -= 1.5;
    if (features.crossesBusyRoads && !features.hasTrafficLights) score -= 1;
    if (durationMinutes > 15) score -= 1;
    if (durationMinutes > 25) score -= 1;
    
    return Math.max(1, Math.round(score * 10) / 10);
}

// Generate detailed accessibility notes
function generateAccessibilityNotes(durationMinutes, features, warnings) {
    const notes = [];
    
    if (durationMinutes <= 5) {
        notes.push("Excellent proximity - very manageable walk");
    } else if (durationMinutes <= 10) {
        notes.push("Good walking distance for most people");
    } else if (durationMinutes <= 20) {
        notes.push("Moderate walk - may require rest stops");
    } else {
        notes.push("Long walk - consider transport alternatives");
    }
    
    if (features.hasStairs) {
        notes.push("Route includes stairs - may be challenging for mobility aids");
    }
    if (features.hasSteepIncline) {
        notes.push("Route has steep sections");
    }
    if (features.crossesBusyRoads) {
        if (features.hasTrafficLights) {
            notes.push("Crosses busy roads but has safe pedestrian crossings");
        } else {
            notes.push("Crosses busy roads - extra care needed");
        }
    }
    
    if (warnings.length === 0 && durationMinutes <= 10) {
        notes.push("Route appears level and pedestrian-friendly");
    }
    
    return notes.join('. ') + '.';
}

// Calculate final GP proximity score
function calculateGPProximityScore(durationMinutes, routeAccessibilityScore = null) {
    let baseScore;
    
    if (durationMinutes <= 5) baseScore = 5;
    else if (durationMinutes <= 10) baseScore = 4;
    else if (durationMinutes <= 20) baseScore = 3;
    else if (durationMinutes <= 30) baseScore = 2;
    else baseScore = 1;
    
    if (routeAccessibilityScore !== null) {
        const adjustedScore = (baseScore + routeAccessibilityScore) / 2;
        return Math.round(adjustedScore * 10) / 10;
    }
    
    return baseScore;
}

// ✅ ENHANCED EPC EXTRACTION with lazy Vision API loading
async function extractEPCFromRightmoveDropdown(url) {
    try {
        console.log('🔍 Enhanced Rightmove EPC detection...');
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 8000
        });

        const $ = cheerio.load(response.data);
        const epcImageUrls = [];
        
        // Strategy 1: Look for PDF brochures
        $('a[href*=".pdf"]').each((i, link) => {
            const href = $(link).attr('href');
            const text = $(link).text().toLowerCase();
            
            if (text.includes('brochure') || text.includes('details') || 
                text.includes('information') || href.toLowerCase().includes('epc')) {
                
                const fullUrl = href.startsWith('http') ? href : 
                              href.startsWith('//') ? `https:${href}` : 
                              `https://www.rightmove.co.uk${href}`;
                
                epcImageUrls.push(fullUrl);
            }
        });
        
        // Strategy 2: Look for direct EPC images
        const epcUrlPatterns = [
            /_EPC_/i, /\/epc\//i, /energy[-_]performance/i,
            /energy[-_]certificate/i, /certificate.*energy/i
        ];
        
        $('*').each((i, element) => {
            const $el = $(element);
            ['src', 'data-src', 'data-lazy-src', 'href', 'data-href', 'data-url'].forEach(attr => {
                const value = $el.attr(attr);
                if (value && epcUrlPatterns.some(pattern => pattern.test(value))) {
                    const fullUrl = value.startsWith('http') ? value : 
                                  value.startsWith('//') ? `https:${value}` : 
                                  `https://www.rightmove.co.uk${value}`;
                    
                    if (!epcImageUrls.includes(fullUrl)) {
                        epcImageUrls.push(fullUrl);
                    }
                }
            });
        });
        
        console.log(`📊 Total potential EPC sources found: ${epcImageUrls.length}`);
        return epcImageUrls.filter(url => url && url.startsWith('http'));

    } catch (error) {
        console.error('❌ Error in enhanced EPC detection:', error.message);
        
        // Strategy 3: Look for direct EPC images in media URLs
        console.log('🖼️ Strategy 3: Looking for direct EPC images...');
        $('img[src*="EPC"], img[data-src*="EPC"]').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && (src.includes('EPC') || src.includes('epc'))) {
                const fullUrl = src.startsWith('http') ? src : 
                              src.startsWith('//') ? `https:${src}` : 
                              `https://www.rightmove.co.uk${src}`;
                
                if (!epcImageUrls.includes(fullUrl)) {
                    epcImageUrls.push(fullUrl);
                    console.log('🎯 Found direct EPC image:', fullUrl);
                }
            }
        });

        // Strategy 4: Look in page scripts for EPC image URLs
        $('script').each((i, script) => {
            const scriptContent = $(script).html() || '';
            const epcMatches = scriptContent.match(/https?:\/\/[^"'\s]*EPC[^"'\s]*/gi);
            if (epcMatches) {
                epcMatches.forEach(match => {
                    if (!epcImageUrls.includes(match)) {
                        epcImageUrls.push(match);
                        console.log('🎯 Found EPC URL in script:', match);
                    }
                });
            }
        });
        return [];
    }
}

// ✅ FULL PROPERTY SCRAPING - Restore all functionality
async function scrapeRightmoveProperty(url) {
    try {
        console.log('Scraping Rightmove URL:', url);

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 8000
        });

        const $ = cheerio.load(response.data);
        const pageText = $('body').text();

        const propertyIdMatch = url.match(/properties\/(\d+)/);
        const propertyId = propertyIdMatch ? propertyIdMatch[1] : 'unknown';

        // Extract coordinates
        let coordinates = null;
        let address = '';
        const scripts = $('script').toArray();

        scripts.forEach(script => {
            const scriptContent = $(script).html() || '';
            const latLngMatch = scriptContent.match(/(?:lat|latitude)["\s]*[:=]\s*([+-]?\d+\.?\d*)/i);
            const lngMatch = scriptContent.match(/(?:lng|longitude|long)["\s]*[:=]\s*([+-]?\d+\.?\d*)/i);

            if (latLngMatch && lngMatch) {
                coordinates = {
                    lat: parseFloat(latLngMatch[1]),
                    lng: parseFloat(lngMatch[1])
                };
                console.log('Found coordinates in script:', coordinates);
            }

            const addressMatch = scriptContent.match(/(?:address|location)["\s]*[:=]\s*["']([^"']+)["']/i);
            if (addressMatch && !address) {
                address = addressMatch[1];
            }
        });

        if (!coordinates) {
            $('[data-lat], [data-latitude]').each((i, el) => {
                const lat = $(el).attr('data-lat') || $(el).attr('data-latitude');
                const lng = $(el).attr('data-lng') || $(el).attr('data-longitude') || $(el).attr('data-long');
                if (lat && lng) {
                    coordinates = {
                        lat: parseFloat(lat),
                        lng: parseFloat(lng)
                    };
                    console.log('Found coordinates in data attributes:', coordinates);
                }
            });
        }

        if (!coordinates) {
            $('iframe[src*="maps"], iframe[src*="google"]').each((i, iframe) => {
                const src = $(iframe).attr('src');
                const coordMatch = src.match(/[@!]([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
                if (coordMatch) {
                    coordinates = {
                        lat: parseFloat(coordMatch[1]),
                        lng: parseFloat(coordMatch[2])
                    };
                    console.log('Found coordinates in map iframe:', coordinates);
                }
            });
        }

        // Extract title, price, description
        const fullTitle = $('title').text();
        const titleMatch = fullTitle.match(/(.+?) for sale/i);
        const title = titleMatch ? titleMatch[1].trim() : fullTitle.split('open-rightmove')[0].trim();

        // Extract location (street and area) - appears above the map
        let location = '';
        
        // Try to find the location heading above the map
        const locationSelectors = [
            'h2', // Start with all H2 elements
            'h1', // Also try H1 elements
            '[class*="location"]', // Any element with "location" in class
            '[class*="address"]', // Any element with "address" in class
            '.property-title', // Common class name
            '.PropertyTitle' // Another common class name
        ];
        
        for (const selector of locationSelectors) {
            const locationElements = $(selector);
            locationElements.each((i, el) => {
                const locationText = $(el).text().trim();
                
                // Check if this looks like a location (has street/area pattern)
                if (locationText && 
                    locationText.length > 5 && 
                    locationText.length < 50 && 
                    !locationText.includes('£') &&
                    !locationText.includes('bedroom') &&
                    !locationText.includes('bathroom') &&
                    !locationText.includes('Property') &&
                    !locationText.includes('for sale') &&
                    (locationText.includes('Street') || 
                     locationText.includes('Road') || 
                     locationText.includes('Avenue') || 
                     locationText.includes('Lane') || 
                     locationText.includes('Close') ||
                     locationText.includes('Drive') ||
                     locationText.includes('Place') ||
                     locationText.includes(','))) {
                    
                    location = locationText;
                    console.log('Found location:', location);
                    return false; // Break out of loop
                }
            });
            
            if (location) break;
        }
        
        // Alternative: Look for location in the immediate vicinity of map-related elements
        if (!location) {
            const mapContainer = $('[class*="map"], [class*="Map"], iframe[src*="maps"]').first();
            if (mapContainer.length) {
                // Look for headings before the map
                const prevElements = mapContainer.prevAll('h1, h2, h3').first();
                if (prevElements.length) {
                    const locationText = prevElements.text().trim();
                    if (locationText && locationText.length > 5 && locationText.length < 50) {
                        location = locationText;
                        console.log('Found location near map:', location);
                    }
                }
            }
        }
        // Final fallback: Look for any text that matches "Street, Area" pattern
        if (!location) {
            const allText = $('body').text();
            const locationMatch = allText.match(/([A-Za-z\s]+ (?:Street|Road|Avenue|Lane|Close|Drive|Place),\s*[A-Za-z\s]+)/g);
            if (locationMatch && locationMatch.length > 0) {
                location = locationMatch[0];
                console.log('Found location via pattern match:', location);
            }
        }
        // Clean up location if found
        if (location) {
            location = location.replace(/^[,\s]+|[,\s]+$/g, ''); // Remove leading/trailing commas and spaces
            console.log('Cleaned location:', location);
        }

        const priceMatch = pageText.match(/£[\d,]+/g);
        const price = priceMatch ? priceMatch[0] : 'Price not available';

        let description = '';
        const descriptionSelectors = [
            '[data-testid="property-description"]',
            '.property-description',
            '[class*="description"]',
            '.PropertyDescription',
            '[data-test="property-description"]'
        ];

        for (const selector of descriptionSelectors) {
            const desc = $(selector).text().trim();
            if (desc && desc.length > 50) {
                description = desc;
                break;
            }
        }

        if (!description) {
            const textSections = pageText.split('\n').filter(line =>
                line.length > 100 &&
                !line.includes('cookie') &&
                !line.includes('navigation') &&
                (line.includes('property') || line.includes('bedroom') || line.includes('kitchen'))
            );
            description = textSections[0] || 'No detailed description available';
        }

        // Extract images and floorplan
        const images = [];
        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && (
                src.includes('rightmove') ||
                src.includes('property') ||
                src.includes('photo')
            ) && !src.includes('logo') && !src.includes('icon')) {
                images.push(src);
            }
        });

        let floorplan = await tryFloorplanURL(propertyId);
        if (!floorplan) {
            $('img').each((i, img) => {
                const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
                const alt = $(img).attr('alt') || '';
                if (src && (alt.toLowerCase().includes('floorplan') ||
                    alt.toLowerCase().includes('floor plan') ||
                    src.includes('floorplan'))) {
                    floorplan = src;
                }
            });
        }

        // Extract basic features
        const bedroomMatch = pageText.match(/(\d+)\s*bedroom/i);
        const bathroomMatch = pageText.match(/(\d+)\s*bathroom/i);

        const features = [];
        if (bedroomMatch) features.push(`${bedroomMatch[1]} bedroom${bedroomMatch[1] > 1 ? 's' : ''}`);
        if (bathroomMatch) features.push(`${bathroomMatch[1]} bathroom${bathroomMatch[1] > 1 ? 's' : ''}`);

        if (description.toLowerCase().includes('garage')) features.push('garage');
        if (description.toLowerCase().includes('garden')) features.push('garden');
        if (description.toLowerCase().includes('parking')) features.push('parking');
        if (description.toLowerCase().includes('ground floor')) features.push('ground floor accommodation');
        if (description.toLowerCase().includes('gas central heating')) features.push('gas central heating');
        if (description.toLowerCase().includes('double glazing')) features.push('double glazing');

        // ✅ RESTORED: Enhanced EPC extraction with comprehensive approach
        console.log('👁️ Starting comprehensive EPC extraction...');

        let epcData = {
            rating: null,
            score: null,
            confidence: 0,
            reason: 'Not extracted',
            numericalScore: 0
        };

        try {
            // STEP 1: Look for CLEAR text declarations first (highest priority)
            console.log('🔍 Step 1: Checking for clear EPC declarations in text...');
            
            const clearDeclarations = [
                /epc\s*[-:]\s*([a-g])\b/gi,           // "EPC - A" or "EPC: A"
                /epc\s+([a-g])\b/gi,                  // "EPC A"
                /energy\s+rating\s*[-:]\s*([a-g])\b/gi, // "Energy Rating - A"
                /([a-g])\s+rated/gi                   // "A Rated"
            ];

            // FIXED: Include ALL text sources including page HTML
            const pageHTML = response.data;
            const fullPageText = $('body').text();
            const allTextSources = `${title} ${description} ${features.join(' ')} ${fullPageText}`.toLowerCase();
            
            console.log('📝 Searching in combined text (first 300 chars):', allTextSources.substring(0, 300));
            console.log('🔍 Looking for "epc" mentions:', allTextSources.match(/[^.]*epc[^.]*/gi)?.slice(0, 3) || 'None found');

            for (const pattern of clearDeclarations) {
                const matches = [...allTextSources.matchAll(pattern)];
                
                for (const match of matches) {
                    const rating = match[1].toUpperCase();
                    const context = allTextSources.substring(
                        Math.max(0, match.index - 50), 
                        match.index + match[0].length + 50
                    );
                    
                    console.log(`🎯 Found potential EPC declaration: "${match[0]}" in context: "${context}"`);
                    
                    // Validate it's really about EPC
                    if (context.includes('epc') || context.includes('energy') || context.includes('rating')) {
                        epcData = {
                            rating: rating,
                            score: null,
                            confidence: 95, // High confidence for clear declarations
                            reason: `Clear text declaration: "${match[0]}"`,
                            numericalScore: 0
                        };
                        
                        console.log(`✅ HIGH CONFIDENCE EPC from clear text: ${rating}`);
                        break; // Exit both loops
                    }
                }
                if (epcData.rating) break; // Exit outer loop if found
            }

            // STEP 2: Try Vision API on EPC images (only if no clear text found)
            if (!epcData.rating) {
                console.log('🔍 Step 2: No clear text found, trying Vision API...');
                
                const epcImageUrls = await extractEPCFromRightmoveDropdown(url);

                // ENHANCED: Additional EPC image search
                console.log('🔍 Searching for direct EPC images in page source...');
                const epcImageMatches = pageHTML.match(/https?:\/\/[^"'\s]*EPC[^"'\s]*\.(png|jpg|jpeg|gif)/gi);
                if (epcImageMatches) {
                    console.log(`🎯 Found ${epcImageMatches.length} EPC images in page source:`, epcImageMatches);
                    epcImageUrls.push(...epcImageMatches);
                }

                const rightmoveEPCMatches = pageHTML.match(/https?:\/\/media\.rightmove\.co\.uk[^"'\s]*EPC[^"'\s]*/gi);
                if (rightmoveEPCMatches) {
                    console.log(`🎯 Found ${rightmoveEPCMatches.length} Rightmove EPC URLs:`, rightmoveEPCMatches);
                    epcImageUrls.push(...rightmoveEPCMatches);
                }

                // ENHANCED: Look for any image URLs containing energy/certificate keywords
                const energyImageMatches = pageHTML.match(/https?:\/\/[^"'\s]*(?:energy|certificate|performance)[^"'\s]*\.(png|jpg|jpeg|gif)/gi);
                if (energyImageMatches) {
                    console.log(`🎯 Found ${energyImageMatches.length} energy-related images:`, energyImageMatches);
                    epcImageUrls.push(...energyImageMatches);
                }

                const uniqueEpcUrls = [...new Set(epcImageUrls)];
                console.log(`📊 Total unique EPC sources found: ${uniqueEpcUrls.length}`, uniqueEpcUrls);
                
                if (uniqueEpcUrls.length > 0 && process.env.CLAUDE_API_KEY && process.env.CLAUDE_API_KEY.length > 10) {
                    console.log('🔑 Claude API key available, trying Vision API...');
                    
                    for (const imageUrl of uniqueEpcUrls.slice(0, 2)) {
                        try {
                            console.log(`👁️ IMPROVED Vision API call for: ${imageUrl.substring(0, 100)}...`);
                            
                            const visionResponse = await axios.post('https://api.anthropic.com/v1/messages', {
                                model: 'claude-3-5-sonnet-20241022',
                                max_tokens: 600,
                                messages: [{
                                    role: 'user',
                                    content: [{
                                        type: 'text',
                                        text: `You are analyzing an EPC (Energy Performance Certificate) image. This is CRITICAL - I need you to be extremely precise about the arrow position.

IMPORTANT: Look at where the arrow tip or pointer is positioned on the A-G rating scale. The bands should be:
- A (Most efficient): Usually at the TOP of the scale
- B, C, D, E, F, G: Going down the scale
- G (Least efficient): Usually at the BOTTOM

Please examine:
1. The exact position of the arrow tip relative to the letter bands
2. Which letter the arrow is clearly pointing to
3. Any numerical score visible (usually 1-100)

Focus specifically on the arrow tip position. Sometimes the arrow shaft might cross multiple bands, but what matters is where the TIP points.

If you see an arrow pointing to the A band (top of scale), it's an A rating.
If you see an arrow pointing to the B band (second from top), it's a B rating.

Return ONLY this format: Rating: [LETTER], Score: [NUMBER if visible], Confidence: [PERCENTAGE]%

Be extremely careful about A vs B distinction.`
                                    }, {
                                        type: 'image',
                                        source: {
                                            type: 'base64',
                                            media_type: imageUrl.toLowerCase().includes('.gif') ? 'image/gif' : 
                                                      imageUrl.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg',
                                            data: await convertImageToBase64(imageUrl)
                                        }
                                    }]
                                }]
                            }, {
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-api-key': process.env.CLAUDE_API_KEY,
                                    'anthropic-version': '2023-06-01'
                                },
                                timeout: 15000
                            });
                            
                            const text = visionResponse.data.content[0].text;
                            console.log('🔍 IMPROVED Vision API response:', text);
                            
                            const ratingMatch = text.match(/Rating:\s*([A-G])/i);
                            const scoreMatch = text.match(/Score:\s*(\d+)/i);
                            
                            if (ratingMatch) {
                                epcData = {
                                    rating: ratingMatch[1].toUpperCase(),
                                    score: scoreMatch ? parseInt(scoreMatch[1]) : null,
                                    confidence: 75, // Lower confidence than clear text
                                    reason: 'Improved Vision API analysis',
                                    numericalScore: scoreMatch ? parseInt(scoreMatch[1]) : 0
                                };
                                
                                console.log(`✅ Vision API result: ${epcData.rating} (score: ${epcData.score})`);
                                break;
                            }
                        } catch (imageError) {
                            console.log(`❌ Vision analysis failed: ${imageError.message}`);
                            continue;
                        }
                    }
                } else {
                    console.log('⚠️ No valid Claude API key or no EPC images found - skipping Vision API');
                }
            }
            
            // STEP 3: Enhanced text patterns (if Vision API also failed)
            if (!epcData.rating && description && description.length > 0) {
                console.log('🔍 Step 3: Using enhanced text pattern matching...');
                
                const enhancedPatterns = [
                    /epc\s*rating[:\s]*([a-g])\b/gi,
                    /energy\s*performance\s*certificate[:\s]*([a-g])\b/gi,
                    /energy\s*efficiency[:\s]*rating[:\s]*([a-g])\b/gi,
                    /current\s*energy\s*rating[:\s]*([a-g])\b/gi,
                    /\bepc[:\s]+([a-g])\b/gi,
                    /\b([a-g])\s*[-:]\s*\d{1,3}\b/gi
                ];
                
                const searchTexts = [
                    { text: description, source: 'description' },
                    { text: fullPageText, source: 'page' }
                ];
                
                searchLoop: for (const { text, source } of searchTexts) {
                    for (const pattern of enhancedPatterns) {
                        const matches = [...text.matchAll(pattern)];
                        
                        for (const match of matches) {
                            const rating = match[1].toUpperCase();
                            
                            const matchContext = text.substring(
                                Math.max(0, match.index - 60), 
                                match.index + 80
                            ).toLowerCase();
                            
                            const hasEnergyContext = (
                                matchContext.includes('energy performance') ||
                                matchContext.includes('energy certificate') ||
                                matchContext.includes('energy efficiency') ||
                                matchContext.includes('epc rating') ||
                                matchContext.includes('energy rating')
                            );
                            
                            const isFinancialContext = (
                                matchContext.includes('deposit') ||
                                matchContext.includes('mortgage') ||
                                matchContext.includes('council tax') ||
                                matchContext.includes('band:')
                            );
                            
                            const isAddressContext = (
                                matchContext.includes('street') ||
                                matchContext.includes('road') ||
                                matchContext.includes('ba2')
                            );
                            
                            const isValidContext = hasEnergyContext && !isFinancialContext && !isAddressContext;
                            
                            if (isValidContext && ['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(rating)) {
                                epcData = {
                                    rating: rating,
                                    score: null,
                                    confidence: 70,
                                    reason: `Enhanced text pattern (${source}): "${match[0]}"`,
                                    numericalScore: 0
                                };
                                
                                console.log(`✅ Found validated EPC in ${source}: ${rating}`);
                                break searchLoop;
                            }
                        }
                    }
                }
            }
            
            // Step 4: FINAL FALLBACK - Search description for explicit "EPC RATING X" format
            if (!epcData.rating && description && description.length > 0) {
                console.log('🔍 Final fallback: Searching description for EPC rating...');
                
                const patterns = [
                    /EPC\s+RATING\s+([A-G])\b/gi,
                    /EPC\s+RATING\s*([A-G])(?=[A-Z])/gi,
                    /EPC\s+Rating\s+([A-G])\b/gi,
                    /EPC\s*:\s*([A-G])\b/gi,
                    /EPC\s+([A-G])\b/gi
                ];
                
                for (const pattern of patterns) {
                    const match = description.match(pattern);
                    if (match) {
                        let rating;
                        if (match[1]) {
                            rating = match[1].toUpperCase();
                        } else {
                            const ratingMatch = match[0].match(/RATING\s*([A-G])/i);
                            rating = ratingMatch ? ratingMatch[1].toUpperCase() : null;
                        }
                        
                        if (rating && ['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(rating)) {
                            epcData = {
                                rating: rating,
                                score: null,
                                confidence: 65,
                                reason: `Final fallback pattern: "${match[0]}"`,
                                numericalScore: 0
                            };
                            
                            console.log(`✅ Found EPC in description: ${rating}`);
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('❌ Enhanced EPC extraction error:', error.message);
            epcData.reason = `Extraction failed: ${error.message}`;
        }

        console.log('=== FINAL EPC RESULT ===');
        console.log('EPC Rating:', epcData.rating);
        console.log('Confidence:', epcData.confidence);
        console.log('Method:', epcData.confidence > 90 ? 'Clear Text (High)' : 
                            epcData.confidence > 70 ? 'Vision API (Medium)' : 
                            epcData.confidence > 60 ? 'Text Pattern (Medium)' : 'Not Found');
        console.log('Reason:', epcData.reason);

        console.log('Property scraping completed:', {
            title: title,
            coordinates: !!coordinates,
            epc: epcData.rating || 'Not found',
            features: features.length
        });

        return {
            id: propertyId,
            title: title,
            location: location,
            price: price,
            description: description,
            features: features,
            images: images.slice(0, 5),
            floorplan: floorplan,
            epc: epcData,
            epcRating: epcData.rating,
            address: address || 'Address not found',
            coordinates: coordinates
        };

    } catch (error) {
        console.error('Scraping error:', error.message);
        throw new Error('Failed to scrape property data');
    }
}

// ✅ UPDATED ACCESSIBILITY ANALYSIS with new Accessible Features
async function analyzePropertyAccessibility(property) {
    console.log('Starting comprehensive property analysis...');
    
    // Step 1: Analyze GP proximity
    let gpProximity = null;
    if (property.coordinates) {
        console.log('Analyzing GP proximity with enhanced search...');
        
        try {
            const nearbyGPs = await findNearestGPs(property.coordinates.lat, property.coordinates.lng);
            
            if (nearbyGPs.length > 0) {
                console.log(`Found ${nearbyGPs.length} GP surgeries nearby`);
                
                const route = await analyzeWalkingRoute(
                    property.coordinates.lat, 
                    property.coordinates.lng,
                    nearbyGPs[0].location.lat,
                    nearbyGPs[0].location.lng,
                    nearbyGPs[0].name
                );
                
                if (route) {
                    gpProximity = {
                        nearestGP: nearbyGPs[0].name,
                        address: nearbyGPs[0].address,
                        walkingTime: route.duration,
                        distance: route.distance,
                        score: calculateGPProximityScore(route.durationMinutes, route.accessibilityScore),
                        routeAccessibilityScore: route.accessibilityScore,
                        accessibilityNotes: route.accessibilityNotes,
                        warnings: route.routeWarnings,
                        allNearbyGPs: nearbyGPs.slice(0, 3).map(gp => ({
                            name: gp.name,
                            address: gp.address
                        }))
                    };
                    
                    console.log('GP proximity analysis complete:', {
                        gp: gpProximity.nearestGP,
                        time: gpProximity.walkingTime,
                        score: gpProximity.score
                    });
                } else {
                    gpProximity = {
                        nearestGP: nearbyGPs[0].name,
                        address: nearbyGPs[0].address,
                        score: 3,
                        accessibilityNotes: 'GP surgery found nearby, but walking route could not be calculated',
                        allNearbyGPs: nearbyGPs.slice(0, 3).map(gp => ({
                            name: gp.name,
                            address: gp.address
                        }))
                    };
                }
            } else {
                gpProximity = {
                    score: 1,
                    accessibilityNotes: 'No GP surgeries found within reasonable walking distance'
                };
            }
        } catch (error) {
            console.error('GP proximity analysis failed:', error.message);
            gpProximity = {
                score: 2,
                accessibilityNotes: 'Unable to analyze GP proximity at this time'
            };
        }
    } else {
        gpProximity = {
            score: 2,
            accessibilityNotes: 'Property location coordinates not available for GP proximity analysis'
        };
    }

    // Step 2: Calculate EPC Score
    let epcScore = 3;
    let epcDetails = 'EPC rating not specified';

    if (property.epc && property.epc.rating && property.epc.confidence >= 50) {
        if (property.epc.numericalScore && property.epc.confidence >= 80) {
            epcScore = Math.max(1, Math.min(5, Math.round((property.epc.numericalScore / 100) * 5)));
            epcDetails = `Energy rating ${property.epc.rating} (score: ${property.epc.numericalScore}) - ${property.epc.confidence}% confidence via ${property.epc.confidence > 80 ? 'Vision API' : 'Text Search'}`;
        } else {
            const letterScores = { 'A': 5, 'B': 4, 'C': 4, 'D': 3, 'E': 2, 'F': 2, 'G': 1 };
            epcScore = letterScores[property.epc.rating] || 3;
            epcDetails = `Energy rating ${property.epc.rating} (${property.epc.confidence}% confidence) - ${property.epc.reason}`;
        }
    } else if (property.epcRating) {
        const rating = property.epcRating.toUpperCase();
        const letterScores = { 'A': 5, 'B': 4, 'C': 4, 'D': 3, 'E': 2, 'F': 2, 'G': 1 };
        epcScore = letterScores[rating] || 3;
        epcDetails = `Energy rating ${rating} (legacy extraction)`;
    }
    
    // Step 3: NEW - Analyze Accessible Features (replaces internal facilities)
    console.log('🏠 Analyzing accessible features...');
    const accessibleFeatures = calculateAccessibleFeaturesScore(property);
    
    const overallScore = (gpProximity.score + epcScore + accessibleFeatures.score) / 3;
    const summary = generateComprehensiveSummary(gpProximity, epcScore, accessibleFeatures, overallScore, property.title, property.epcRating, property.location);
    return {
        gpProximity: {
            score: gpProximity.score || 0,
            rating: getScoreRating(gpProximity.score || 0),
            details: gpProximity.accessibilityNotes || 'No details available',
            nearestGP: gpProximity.nearestGP || null,
            address: gpProximity.address || null,
            walkingTime: gpProximity.walkingTime || null,
            distance: gpProximity.distance || null,
            warnings: gpProximity.warnings || [],
            allNearbyGPs: gpProximity.allNearbyGPs || []
        },
        epcRating: {
            score: epcScore || 0,
            rating: getScoreRating(epcScore || 0),
            details: epcDetails || 'No EPC details available',
            actualRating: property.epc?.rating || property.epcRating || null,
            confidence: property.epc?.confidence || 0,
            method: property.epc?.confidence > 80 ? 'Vision API' : 
                    property.epc?.confidence > 50 ? 'Text Search' : 'Default'
        },
        // NEW: Accessible Features (replaces internalFacilities)
        accessibleFeatures: {
            score: accessibleFeatures.score || 0,
            rating: getScoreRating(accessibleFeatures.score || 0),
            details: `${accessibleFeatures.percentage}% - ${accessibleFeatures.score} out of 5 accessible features found`,
            features: accessibleFeatures.features || [],
            percentage: accessibleFeatures.percentage || 0
        },
        overall: Math.round((overallScore || 0) * 10) / 10,
        summary: summary || 'Analysis completed successfully'
    };
}

// ENHANCED: Generate detailed structured summary
function generateComprehensiveSummary(gpProximity, epcScore, accessibleFeatures, overallScore, title, epcRating) {
    let summary = "";
    
    const accessibleFeaturesScore = accessibleFeatures.score || 0;
    
    // Extract property details from title
    let propertyDescription = "property";
    if (title) {
        const titleLower = title.toLowerCase();
        if (titleLower.includes("bedroom")) {
            const bedroomMatch = titleLower.match(/(\d+)\s*bedroom/);
            if (bedroomMatch) {
                const propertyTypeMatch = titleLower.match(/\d+\s*bedroom\s*(\w+)/);
                const propertyType = propertyTypeMatch ? propertyTypeMatch[1] : "property";
                propertyDescription = `${bedroomMatch[1]} bedroom ${propertyType}`;
            }
        }
    }
    
    // Overall assessment with property details
    summary += `This ${propertyDescription}`;
    if (location) {
        summary += ` in ${location}`;
    }
    summary += ` `;
    
    if (overallScore >= 4) {
        summary += "offers excellent accessibility features for older adults. ";
    } else if (overallScore >= 3) {
        summary += "offers good accessibility features for older adults. ";
    } else if (overallScore >= 2) {
        summary += "has mixed accessibility features for older adults. ";
    } else {
        summary += "presents accessibility challenges for older adults. ";
    }
    
    // GP Proximity details
    let gpRating = "poor";
    if (gpProximity.score >= 4.5) gpRating = "excellent";
    else if (gpProximity.score >= 3.5) gpRating = "good";
    else if (gpProximity.score >= 2.5) gpRating = "fair";
    
    summary += `The GP proximity is ${gpRating}`;
    
    if (gpProximity.score >= 4) {
        summary += " as the route appears short and pedestrian-friendly";
    } else if (gpProximity.score >= 3) {
        summary += " with a reasonable walking distance";
    } else if (gpProximity.score >= 2) {
        summary += " though the walking distance may be challenging for some";
    } else {
        summary += " due to significant walking distance or accessibility barriers";
    }
    
    if (gpProximity.nearestGP) {
        summary += ` to ${gpProximity.nearestGP}`;
    }
    summary += ". ";
    
    // EPC Rating details with letter grade
    let epcRatingText = "poor";
    if (epcScore >= 4.5) epcRatingText = "excellent";
    else if (epcScore >= 3.5) epcRatingText = "good";
    else if (epcScore >= 2.5) epcRatingText = "fair";
    
    summary += `The energy efficiency is ${epcRatingText}`;
    if (epcRating) {
        summary += ` with a ${epcRating} rating`;
    }
    summary += ". ";
    
    // Accessible Features - detailed breakdown with specific missing features
    if (accessibleFeaturesScore >= 4) {
        summary += "The property excels in accessible features.";
    } else if (accessibleFeaturesScore >= 3) {
        summary += "The property has good accessible features.";
    } else {
        summary += "The main concerns for this property are limited accessible features. ";
        
        // List specific missing features
        const foundFeatures = accessibleFeatures.features || [];
        const missingFeatures = [];
        
        const allFeatures = [
            { key: 'lateral', name: 'lateral living' },
            { key: 'bedroom', name: 'downstairs bedroom' },
            { key: 'bathroom', name: 'downstairs bathroom' },
            { key: 'access', name: 'level access to the property' },
            { key: 'parking', name: 'private off-street parking' }
        ];
        
        allFeatures.forEach(feature => {
            const isFound = foundFeatures.some(found => 
                found.toLowerCase().includes(feature.key) || 
                found.toLowerCase().includes(feature.name.split(' ')[0])
            );
            if (!isFound) {
                missingFeatures.push(feature.name);
            }
        });
        
        if (missingFeatures.length > 0) {
            summary += `Specifically, there is no ${missingFeatures.join(', no ')}.`;
        }
    }
    
    return summary;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/api/analyze', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url || !url.includes('rightmove.co.uk')) {
            return res.status(400).json({ 
                error: 'Please provide a valid Rightmove property URL' 
            });
        }

        console.log('Analyzing property:', url);

        // Overall timeout for the request
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Analysis timeout')), 30000) // 30 seconds
        );

        const analysisPromise = async () => {
            const property = await scrapeRightmoveProperty(url);
            const analysis = await analyzePropertyAccessibility(property);
            
            return {
                property: {
                    title: property.title,
                    price: property.price,
                    url: url
                },
                analysis: analysis,
                timestamp: new Date().toISOString()
            };
        };

        const result = await Promise.race([analysisPromise(), timeoutPromise]);
        res.json(result);

    } catch (error) {
        console.error('Analysis error:', error.message);
        res.status(500).json({ 
            error: error.message || 'Failed to analyze property' 
        });
    }
});

// 🔑 API KEY VALIDATION at startup
async function validateAPIKey() {
    if (!process.env.CLAUDE_API_KEY) {
        console.warn('⚠️  No CLAUDE_API_KEY found in environment variables');
        return false;
    }
    
    const apiKey = process.env.CLAUDE_API_KEY;
    console.log('🔑 Checking Claude API key...');
    console.log(`   Key format: ${apiKey.substring(0, 15)}...${apiKey.substring(apiKey.length - 5)}`);
    console.log(`   Key length: ${apiKey.length} characters`);
    
    // Check format
    if (!apiKey.startsWith('sk-ant-api')) {
        console.error('❌ Invalid API key format - should start with "sk-ant-api"');
        return false;
    }
    
    if (apiKey.length < 50) {
        console.error('❌ API key seems too short');
        return false;
    }
    
    // Test API call
    try {
        console.log('🧪 Testing API key with simple call...');
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022', // Updated to newer model
            max_tokens: 10,
            messages: [{
                role: 'user',
                content: 'Hi'
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            timeout: 10000
        });
        
        console.log('✅ API key is valid and working!');
        
        // Test Vision capability
        try {
            console.log('👁️ Testing Vision capability...');
            const visionResponse = await axios.post('https://api.anthropic.com/v1/messages', {
                model: 'claude-3-5-sonnet-20241022', // Updated model
                max_tokens: 50,
                messages: [{
                    role: 'user',
                    content: [{
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
                        }
                    }, {
                        type: 'text',
                        text: 'What color is this?'
                    }]
                }]
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                timeout: 10000
            });
            
            console.log('✅ Vision API is enabled and working!');
            return true;
            
        } catch (visionError) {
            if (visionError.response?.status === 400 && 
                visionError.response?.data?.error?.message?.includes('image')) {
                console.log('❌ Vision API not enabled for this key');
            } else {
                console.log('⚠️ Vision test inconclusive:', visionError.response?.data?.error?.message || visionError.message);
            }
            return true; // API key works, just no vision
        }
        
    } catch (error) {
        if (error.response?.status === 401) {
            console.error('❌ API key authentication failed (401)');
            console.error('   This API key is invalid, expired, or revoked');
        } else if (error.response?.status === 403) {
            console.error('❌ API key permissions denied (403)');
        } else {
            console.error('❌ API test failed:', error.response?.data?.error?.message || error.message);
        }
        return false;
    }
}

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🏠 Home Accessibility Score API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log('🎯 Updated with Accessible Features scoring system');
    console.log('');
    
    // Validate API key on startup
    const isValid = await validateAPIKey();
    console.log('');
    
    if (!isValid) {
        console.log('🔧 To fix API key issues:');
        console.log('   1. Go to console.anthropic.com');
        console.log('   2. Click "Get API Key" or navigate to API settings');
        console.log('   3. Generate a new API key');
        console.log('   4. Update your CLAUDE_API_KEY environment variable');
        console.log('');
    }
    
    console.log('🚀 Server ready for requests with new Accessible Features scoring');
    console.log('✅ Scoring now includes:');
    console.log('   • Lateral living/single floor (ground level)');
    console.log('   • Downstairs bedroom');
    console.log('   • Downstairs bathroom/WC');
    console.log('   • Level/ramp access');
    console.log('   • Off-street/private parking');
});

module.exports = app;
