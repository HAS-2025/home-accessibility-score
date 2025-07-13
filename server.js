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
// Add this validation function at the top of your file (before the Vision API call)
function validateEPCFromDescription(visionText) {
    console.log('🔍 Validating EPC from Vision API description:', visionText);
    
    // Extract information from the description
    const currentMatch = visionText.match(/current rating[:\s]*([a-g])\s*(?:band\s*)?(?:with\s*score\s*)?(\d+)?/i);
    const scoreMatch = visionText.match(/(?:score|points?)[:\s]*(\d+)/i);
    const orangeArrowMatch = visionText.match(/orange arrow.*?([a-g])\s*band/i);
    const fBandMatch = visionText.match(/([a-g])\s*band.*?(\d+)/i);
    
    // Try to extract rating from various patterns
    let detectedRating = null;
    let detectedScore = null;
    
    if (currentMatch) {
        detectedRating = currentMatch[1].toUpperCase();
        detectedScore = currentMatch[2] ? parseInt(currentMatch[2]) : null;
    } else if (orangeArrowMatch) {
        detectedRating = orangeArrowMatch[1].toUpperCase();
    } else if (scoreMatch) {
        detectedScore = parseInt(scoreMatch[1]);
    }
    
    if (!detectedScore && scoreMatch) {
        detectedScore = parseInt(scoreMatch[1]);
    }
    
    // Score-based rating detection
    if (detectedScore && !detectedRating) {
        if (detectedScore >= 92) detectedRating = 'A';
        else if (detectedScore >= 81) detectedRating = 'B';
        else if (detectedScore >= 69) detectedRating = 'C';
        else if (detectedScore >= 55) detectedRating = 'D';
        else if (detectedScore >= 39) detectedRating = 'E';
        else if (detectedScore >= 21) detectedRating = 'F';
        else detectedRating = 'G';
        
        console.log(`🔧 Score-based detection: Score ${detectedScore} → Rating ${detectedRating}`);
    }
    
    // Validate rating matches score
    if (detectedRating && detectedScore) {
        const expectedRanges = {
            'A': [92, 100], 'B': [81, 91], 'C': [69, 80], 'D': [55, 68],
            'E': [39, 54], 'F': [21, 38], 'G': [1, 20]
        };
        
        const range = expectedRanges[detectedRating];
        if (range && (detectedScore < range[0] || detectedScore > range[1])) {
            console.log(`⚠️ Rating ${detectedRating} doesn't match score ${detectedScore}, correcting...`);
            
            // Auto-correct based on score
            for (const [correctRating, correctRange] of Object.entries(expectedRanges)) {
                if (detectedScore >= correctRange[0] && detectedScore <= correctRange[1]) {
                    console.log(`🔧 Corrected from ${detectedRating} to ${correctRating}`);
                    detectedRating = correctRating;
                    break;
                }
            }
        }
    }
    
    return {
        rating: detectedRating,
        score: detectedScore,
        confidence: detectedRating ? 80 : 0
    };
}
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
    
    // 4. LEVEL AND/OR RAMP ACCESS - Enhanced Keywords (Fixed)
    const levelAccessKeywords = [
        'level access', 'step-free access', 'step free access', 'no steps',
        'wheelchair accessible', 'ramp access', 'ramped access', 'access ramp',
        'disabled access', 'mobility access', 'ground level access',
        'flat access', 'level entry', 'step-free entry', 'barrier-free access',
        'accessible entrance', 'level entrance', 'no step access'
    ];
    
    const hasLevelAccess = levelAccessKeywords.some(keyword => fullText.includes(keyword));
    
    if (hasLevelAccess) {
        // Add this logging to see which keyword matched
        const matchedKeyword = levelAccessKeywords.find(keyword => fullText.includes(keyword));
        console.log('✓ Found level/ramp access via keyword:', matchedKeyword);
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
// STEP 1: Add this AI detection function at the top of your file (near other functions)

// Replace the old isActualGP function with this batch version:
async function batchDetectGPs(places) {
    const placeList = places.map((place, index) => 
        `${index + 1}. "${place.displayName?.text}" - ${place.formattedAddress}`
    ).join('\n');

    try {
        const prompt = `Which of these are actual GP surgeries/medical practices that provide primary healthcare?

${placeList}

Return only the numbers of the actual GPs (e.g., "1,3,5"). 
GPs provide general medical care - NOT specialists like nutrition, dentistry, imaging, etc.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 50,
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            timeout: 5000
        });

        const result = response.data.content[0].text.trim();
        const validIndices = result.split(',').map(n => parseInt(n.trim()) - 1);
        
        console.log(`🤖 Batch AI Detection: Valid GPs at indices ${validIndices}`);
        return validIndices;
        
    } catch (error) {
        console.log('⚠️ Batch AI detection failed, using fallback');
        return null;
    }
}

// Add this improved fallback function:
function smartFallbackDetection(name, address) {
    const nameLower = name.toLowerCase();
    
    // Quick fake detection
    if (nameLower.includes('bot') || nameLower.includes('jifjaff')) {
        return false;
    }
    
    // Obvious non-GPs (from your working examples)
    const obviousNonGPs = [
        'nutrition', 'chiropody', 'nuclear medicine', 'imaging', 
        'dentist', 'physio', 'beauty', 'aesthetic', 'spa'
    ];
    
    if (obviousNonGPs.some(term => nameLower.includes(term))) {
        console.log(`❌ SMART FALLBACK: ${name} - Not a GP`);
        return false;
    }
    
    // Obvious GPs
    const obviousGPs = [
        'surgery', 'medical practice', 'health centre', 'gp',
        'dr ', 'medical centre'
    ];
    
    if (obviousGPs.some(term => nameLower.includes(term))) {
        console.log(`✅ SMART FALLBACK: ${name} - Is a GP`);
        return true;
    }
    
    // When unsure, be inclusive (like your current fallback)
    console.log(`✅ SMART FALLBACK: ${name} - Probably a GP`);
    return true;
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
            const gps = [];

            // Try batch AI detection first
            const validGPIndices = await batchDetectGPs(response.data.places);
            
            if (validGPIndices && validGPIndices.length > 0) {
                console.log(`🤖 AI found ${validGPIndices.length} valid GPs, processing them...`);
                
                // Process only the AI-confirmed GPs
                for (const index of validGPIndices) {
                    const place = response.data.places[index];
                    if (!place) continue;
                    
                    const name = place.displayName?.text || '';
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        console.log(`Skipping closed place: ${name}`);
                        continue;
                    }
                    
                    // Process the valid GP
                    const gpLat = place.location?.latitude;
                    const gpLng = place.location?.longitude;
                    
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
                    
                    console.log(`📍 VALID GP: ${gpInfo.name}`);
                    console.log(`   Address: ${gpInfo.address}`);
                    console.log(`   Coordinates: ${gpLat}, ${gpLng}`);
                    console.log(`   Straight-line distance: ${straightLineDistance.toFixed(2)} km`);
                    console.log(`   ---`);
                    
                    gps.push(gpInfo);
                    
                    if (gps.length >= 5) break;
                }
            } else {
                console.log(`⚠️ AI detection failed, using smart fallback for all places...`);
                
                // Fallback to smart detection
                for (const place of response.data.places) {
                    const name = place.displayName?.text || '';
                    const address = place.formattedAddress || '';
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        console.log(`Skipping closed place: ${name}`);
                        continue;
                    }
                    
                    if (smartFallbackDetection(name, address)) {
                        // Process the GP (same logic as above)
                        const gpLat = place.location?.latitude;
                        const gpLng = place.location?.longitude;
                        
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
                        
                        console.log(`📍 FALLBACK GP: ${gpInfo.name}`);
                        console.log(`   Address: ${gpInfo.address}`);
                        console.log(`   Coordinates: ${gpLat}, ${gpLng}`);
                        console.log(`   Straight-line distance: ${straightLineDistance.toFixed(2)} km`);
                        console.log(`   ---`);
                        
                        gps.push(gpInfo);
                        
                        if (gps.length >= 5) break;
                    }
                }
            }
            
            console.log(`Found ${gps.length} valid GP surgeries using batch AI detection`);

            
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

// ✅ PUBLIC TRANSPORT ANALYSIS
async function analyzePublicTransport(lat, lng) {
    try {
        console.log(`🚌 Finding public transport near ${lat}, ${lng}`);
        
        // Find nearby bus stops
        const busStops = await findNearbyTransit(lat, lng, 'bus_station');
        
        // Find nearby train stations  
        const trainStations = await findNearbyTransit(lat, lng, 'train_station');
        
        // Calculate score based on distance only
        const transitScore = calculateTransitScore(busStops, trainStations);
        
        console.log(`🚌 Found ${busStops.length} bus stops, ${trainStations.length} train stations`);
        console.log(`🚌 Public transport score: ${transitScore}/5`);
        
        return {
            score: transitScore,
            busStops: busStops.slice(0, 3), // Top 3 nearest
            trainStations: trainStations.slice(0, 3),
            summary: generateTransitSummary(transitScore, busStops, trainStations)
        };
        
    } catch (error) {
        console.error('Public transport analysis failed:', error.message);
        return {
            score: 2,
            busStops: [],
            trainStations: [],
            summary: 'Public transport analysis unavailable'
        };
    }
}

async function findNearbyTransit(lat, lng, transitType) {
    try {
        const requestBody = {
            includedTypes: [transitType],
            maxResultCount: 10,
            locationRestriction: {
                circle: {
                    center: { latitude: lat, longitude: lng },
                    radius: 2000.0 // 2km radius
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
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.id'
                },
                timeout: 8000
            }
        );
        
        if (response.data.places && response.data.places.length > 0) {
            return response.data.places.map(place => ({
                name: place.displayName?.text || `${transitType.replace('_', ' ')}`,
                address: place.formattedAddress || 'Address not available',
                location: {
                    lat: place.location?.latitude,
                    lng: place.location?.longitude
                },
                distance: calculateStraightLineDistance(lat, lng, place.location?.latitude, place.location?.longitude),
                walkingTime: Math.round((calculateStraightLineDistance(lat, lng, place.location?.latitude, place.location?.longitude) * 1000) / 80), // 80m/min walking speed
                placeId: place.id
            })).sort((a, b) => a.distance - b.distance);
        }
        
        return [];
        
    } catch (error) {
        console.error(`${transitType} search failed:`, error.message);
        return [];
    }
}

function calculateTransitScore(busStops, trainStations) {
    const nearestBusDistance = busStops[0]?.distance ? busStops[0].distance * 1000 : Infinity; // Convert km to meters
    const nearestTrainDistance = trainStations[0]?.distance ? trainStations[0].distance * 1000 : Infinity;
    
    console.log(`🚌 Nearest bus: ${nearestBusDistance}m, Nearest train: ${nearestTrainDistance}m`);
    
    // Scoring criteria based on your requirements
    if ((nearestBusDistance <= 200 && nearestTrainDistance <= 800)) return 5;
    if (nearestBusDistance <= 400 || nearestTrainDistance <= 1200) return 4;
    if (nearestBusDistance <= 600 || nearestTrainDistance <= 1500) return 3;
    if (nearestBusDistance <= 800 || nearestTrainDistance <= 2000) return 2;
    return 1;
}

function generateTransitSummary(score, busStops, trainStations) {
    let summary = ``;
    
    if (busStops.length > 0) {
        summary += "🚌 **Nearest Bus Stops:**\n";
        busStops.slice(0, 3).forEach((stop, index) => {
            summary += `${index + 1}. **${stop.name}** (${Math.round(stop.distance * 1000)}m away, ${stop.walkingTime}-min walk)\n`;
        });
        summary += "\n";
    }
    
    if (trainStations.length > 0) {
        summary += "🚂 **Nearest Train Stations:**\n";
        trainStations.slice(0, 3).forEach((station, index) => {
            summary += `${index + 1}. **${station.name}** (${Math.round(station.distance * 1000)}m away, ${station.walkingTime}-min walk)\n`;
        });
        summary += "\n";
    }
    
    if (busStops.length === 0 && trainStations.length === 0) {
        summary += "No public transport found within 2km walking distance.\n";
    }
    
    return summary;
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
                            
                            // Replace your existing Vision API call with this updated version:
                            const visionResponse = await axios.post('https://api.anthropic.com/v1/messages', {
                                model: 'claude-3-5-sonnet-20241022',
                                max_tokens: 600,
                                messages: [{
                                    role: 'user',
                                    content: [{
                                        type: 'text',
                                        text: `You are analyzing an EPC (Energy Performance Certificate) chart. 

CRITICAL INSTRUCTIONS:
1. There are TWO columns: "Current" (left) and "Potential" (right)
2. I need the CURRENT rating only (left column)
3. Look for the arrow in the CURRENT column that points to a letter band (A-G)
4. The arrow color often matches the band color (F=orange, D=yellow, etc.)

CURRENT RATING IDENTIFICATION:
- Find the arrow in the LEFT column labeled "Current"
- Identify which letter band (A, B, C, D, E, F, or G) the arrow points to
- Note the numerical score if visible
- Ignore the "Potential" column on the right

SCORING RANGES (for validation):
- A: 92-100 (dark green)
- B: 81-91 (light green) 
- C: 69-80 (yellow-green)
- D: 55-68 (yellow)
- E: 39-54 (orange)
- F: 21-38 (red-orange)
- G: 1-20 (red)

Look carefully at the CURRENT column and tell me:
1. Which letter band the arrow points to
2. The numerical score if visible
3. Verify the score matches the expected range for that letter

RESPOND EXACTLY IN THIS FORMAT:
Current Rating: [LETTER]
Current Score: [NUMBER or "not visible"]
Confidence: [PERCENTAGE]%

Focus ONLY on the current rating (left column). Do not get confused by the potential rating.`
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

// Try both the standard parsing AND the validation function
let epcResult = null;

// Standard parsing
const ratingMatch = text.match(/(?:Current\s+)?Rating:\s*([A-G])/i);
const scoreMatch = text.match(/(?:Current\s+)?Score:\s*(\d+)/i);

if (ratingMatch) {
    epcResult = {
        rating: ratingMatch[1].toUpperCase(),
        score: scoreMatch ? parseInt(scoreMatch[1]) : null,
        confidence: 75
    };
}

// If standard parsing fails or gives weird results, use validation
if (!epcResult || !epcResult.rating) {
    console.log('🔍 Standard parsing failed, trying validation approach...');
    epcResult = validateEPCFromDescription(text);
}

// Final validation
if (epcResult && epcResult.rating && epcResult.score) {
    const correctedResult = validateEPCFromDescription(`rating ${epcResult.rating} score ${epcResult.score}`);
    if (correctedResult.rating !== epcResult.rating) {
        console.log(`🔧 Final correction: ${epcResult.rating} → ${correctedResult.rating}`);
        epcResult.rating = correctedResult.rating;
    }
}

if (epcResult && epcResult.rating) {
    epcData = {
        rating: epcResult.rating,
        score: epcResult.score,
        confidence: epcResult.confidence,
        reason: 'Improved Vision API analysis with validation',
        numericalScore: epcResult.score || 0
    };
    
    console.log(`✅ Vision API result: ${epcData.rating} (score: ${epcData.score})`);
           break;
                            }
                        } catch (imageError) {
                            console.log(`❌ Vision analysis failed: ${imageError.message}`);
                            continue;
                        }
                    }        // ← ADD THIS: closes the for loop
                } else {
                    console.log('⚠️ No valid Claude API key or no EPC images found - skipping Vision API');
                }
            }           // ← ADD THIS: closes the if (!epcData.rating)   
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
        
        console.log('🏠 About to return property data...');
        console.log('Location variable before return:', location);
        console.log('Title:', title);
        console.log('Price:', price);
        
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
function calculateEPCScore(epcRating) {
    if (!epcRating) return { score: 3, rating: 'Not available', description: 'Energy rating not available' };
    
    const rating = epcRating.toUpperCase();
    
    switch (rating) {
        case 'A':
        case 'B':
            return {
                score: 5,
                rating: 'Excellent',
                description: `Energy rating ${rating} - This property has excellent energy efficiency and may have lower heating costs.`
            };
        
        case 'C':
            return {
                score: 4,
                rating: 'Good',
                description: `Energy rating ${rating} - This property has good energy efficiency and may have lower heating costs.`
            };
            
        case 'D':
            return {
                score: 3,
                rating: 'Average',
                description: `Energy rating ${rating} - This property has average energy efficiency and may have moderate heating costs.`
            };
            
        case 'E':
        case 'F':
        case 'G':
            return {
                score: 2,
                rating: 'Poor',
                description: `Energy rating ${rating} - This property has poor energy efficiency and may have higher heating costs.`
            };
            
        default:
            return {
                score: 3,
                rating: 'Unknown',
                description: 'Energy rating not available'
            };
    }
}

// Get EPC rating from property data
let epcRating = null;
if (property.epc && property.epc.rating && property.epc.confidence >= 50) {
    epcRating = property.epc.rating;
} else if (property.epcRating) {
    epcRating = property.epcRating;
}

// Calculate score and details
const epcAnalysis = calculateEPCScore(epcRating);
const epcScore = epcAnalysis.score;
const epcDetails = epcAnalysis.description;
    
    // Step 3: NEW - Analyze Accessible Features (replaces internal facilities)
    console.log('🏠 Analyzing accessible features...');
    const accessibleFeatures = calculateAccessibleFeaturesScore(property);
    
    // Step 4: NEW - Analyze Public Transport
    let publicTransport = null;
    if (property.coordinates) {
        console.log('🚌 Analyzing public transport...');
        try {
            publicTransport = await analyzePublicTransport(property.coordinates.lat, property.coordinates.lng);
        } catch (error) {
            console.error('Public transport analysis failed:', error.message);
            publicTransport = {
                score: 2,
                busStops: [],
                trainStations: [],
                summary: 'Public transport analysis unavailable'
            };
        }
    } else {
        publicTransport = {
            score: 2,
            busStops: [],
            trainStations: [],
            summary: 'Property location coordinates not available for public transport analysis'
        };
    }
    
    // Updated overall score calculation (4 categories now)
    const overallScore = (gpProximity.score + epcScore + accessibleFeatures.score + publicTransport.score) / 4;
    const summary = generateComprehensiveSummary(gpProximity, epcScore, accessibleFeatures, publicTransport, overallScore, property.title, property.epcRating, property.location);
    
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
        accessibleFeatures: {
            score: accessibleFeatures.score || 0,
            rating: getScoreRating(accessibleFeatures.score || 0),
            details: `${accessibleFeatures.percentage}% - ${accessibleFeatures.score} out of 5 accessible features found`,
            features: accessibleFeatures.features || [],
            percentage: accessibleFeatures.percentage || 0
        },
        // NEW: Public Transport
        publicTransport: {
            score: publicTransport.score || 0,
            rating: getScoreRating(publicTransport.score || 0),
            details: '', // EMPTY STRING
            busStops: publicTransport.busStops || [],
            trainStations: publicTransport.trainStations || []
        },
        overall: Math.round((overallScore || 0) * 10) / 10,
        summary: summary || 'Analysis completed successfully'
    };
}

// Add publicTransport parameter to the function
function generateComprehensiveSummary(gpProximity, epcScore, accessibleFeatures, publicTransport, overallScore, title, epcRating, location) {
    let summary = "";
    
    const accessibleFeaturesScore = accessibleFeatures.score || 0;
    
    // Extract property details from title (keep your existing logic)
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
    
    // 1. Property introduction with overall accessibility assessment
    summary += `This ${propertyDescription}`;
    if (location) {
        summary += ` in ${location}`;
    }
    
    // Use the overall score that's calculated elsewhere (matches the top of page display)
    let overallRating = "Limited";
    if (overallScore >= 4) overallRating = "Excellent";
    else if (overallScore >= 3) overallRating = "Good"; 
    else if (overallScore >= 2) overallRating = "Fair";
    
    summary += ` offers ${overallRating.toLowerCase()} accessibility features for older adults, with an overall accessibility score of ${Math.round(overallScore * 10) / 10}/5 (${overallRating}). `;
    
    // 2. Key accessibility strengths - focus on what works well
    if (accessibleFeaturesScore >= 3) {
        summary += "The property's key strength is its accessible design, featuring ";
        
        const foundFeatures = accessibleFeatures.features || [];
        const accessibilityHighlights = [];
        
        if (foundFeatures.some(f => f.toLowerCase().includes('lateral') || f.toLowerCase().includes('single floor'))) {
            accessibilityHighlights.push("complete single-level living that eliminates stairs from daily life");
        }
        if (foundFeatures.some(f => f.toLowerCase().includes('bedroom'))) {
            accessibilityHighlights.push("a downstairs bedroom for flexible sleeping arrangements");
        }
        if (foundFeatures.some(f => f.toLowerCase().includes('bathroom'))) {
            accessibilityHighlights.push("downstairs bathroom facilities");
        }
        if (foundFeatures.some(f => f.toLowerCase().includes('parking'))) {
            accessibilityHighlights.push("private parking that eliminates street parking challenges");
        }
        
        if (accessibilityHighlights.length > 0) {
            summary += accessibilityHighlights.join(', ') + ". ";
        }
    }
    
    // 3. Healthcare access from accessibility perspective
    let gpRating = "limited";
    if (gpProximity.score >= 4.5) gpRating = "excellent";
    else if (gpProximity.score >= 3.5) gpRating = "good";
    else if (gpProximity.score >= 2.5) gpRating = "fair";
    
    summary += `For healthcare independence, the GP proximity is ${gpRating}`;
    
    if (gpProximity.score >= 4) {
        summary += " with easy walking access that supports medical independence";
    } else if (gpProximity.score >= 3) {
        summary += " with reasonable walking distance to maintain healthcare autonomy";
    } else if (gpProximity.score >= 2) {
        summary += ", though the walking distance may challenge those with mobility limitations";
    } else {
        summary += " due to significant distance that may require transport assistance";
    }
    
    if (gpProximity.nearestGP) {
        summary += ` to ${gpProximity.nearestGP}`;
    }
    summary += ". ";

    // NEW: Public Transport Context
    let transportRating = "limited";
    if (publicTransport.score >= 4.5) transportRating = "excellent";
    else if (publicTransport.score >= 3.5) transportRating = "good";
    else if (publicTransport.score >= 2.5) transportRating = "fair";
    
    summary += `Public transport connectivity is ${transportRating}`;
    
    if (publicTransport.score >= 4) {
        summary += " with convenient access to buses and trains that supports independent travel";
    } else if (publicTransport.score >= 3) {
        summary += " with reasonable access to public transport for regular journeys";
    } else if (publicTransport.score >= 2) {
        summary += ", though limited options may require planning for longer journeys";
    } else {
        summary += " due to minimal nearby public transport options";
    }
    
    const nearestBus = publicTransport.busStops?.[0];
    const nearestTrain = publicTransport.trainStations?.[0];
    
    if (nearestBus || nearestTrain) {
        summary += " (";
        const transportDetails = [];
        if (nearestBus) transportDetails.push(`bus ${Math.round(nearestBus.distance * 1000)}m away`);
        if (nearestTrain) transportDetails.push(`train station ${Math.round(nearestTrain.distance * 1000)}m away`);
        summary += transportDetails.join(', ');
        summary += ")";
    }
    summary += ". ";
    
    // 4. Accessibility considerations and limitations
    const foundFeatures = accessibleFeatures.features || [];
    const missingFeatures = [];
    
    const allFeatures = [
        { key: 'lateral', name: 'single-level living', critical: true },
        { key: 'bedroom', name: 'downstairs bedroom', critical: false },
        { key: 'bathroom', name: 'downstairs bathroom/WC', critical: true },
        { key: 'access', name: 'level access to the property', critical: true },
        { key: 'parking', name: 'off-street parking', critical: false }
    ];
    
    allFeatures.forEach(feature => {
        const isFound = foundFeatures.some(found => 
            found.toLowerCase().includes(feature.key) || 
            found.toLowerCase().includes(feature.name.split(' ')[0])
        );
        if (!isFound) {
            missingFeatures.push(feature);
        }
    });
    
    if (missingFeatures.length > 0) {
        const criticalMissing = missingFeatures.filter(f => f.critical);
        if (criticalMissing.length > 0) {
            summary += `Important accessibility considerations include the lack of ${criticalMissing.map(f => f.name).join(' and ')}, which may limit suitability for wheelchair users or those with significant mobility challenges. `;
        }
    }
    
    // 5. Energy efficiency in context of comfort and accessibility
    let epcRatingText = "poor";
    if (epcScore >= 4.5) epcRatingText = "excellent";
    else if (epcScore >= 3.5) epcRatingText = "good";
    else if (epcScore >= 2.5) epcRatingText = "fair";
    
    if (epcScore < 3) {
        summary += `The energy efficiency is ${epcRatingText}`;
        if (epcRating) {
            summary += ` with a ${epcRating} rating`;
        }
        summary += ", which may result in higher heating costs that could impact comfort for temperature-sensitive residents. ";
    }
    
    // 6. Final recommendation integrated into sentence
    summary += "This property would be best suited for ";
    if (overallScore >= 4) {
        summary += "seniors across a wide range of mobility levels, particularly those planning to age in place.";
    } else if (overallScore >= 3) {
        summary += "active seniors and those with mild mobility considerations who value accessible features.";
    } else if (overallScore >= 2) {
        summary += "seniors with good mobility who can adapt to some accessibility limitations.";
    } else {
        summary += "seniors who can make significant modifications, as the property may require substantial accessibility improvements.";
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
                    location: property.location,
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
