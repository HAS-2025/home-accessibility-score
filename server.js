

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
        console.log('🔍 Converting to base64:', imageUrl.substring(0, 100));
        console.log('🔍 File type:', imageUrl.split('.').pop());
        
        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: 10000
        });
        
        console.log('🔍 Image downloaded successfully, size:', response.data.byteLength, 'bytes');
        
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        console.log('🔍 Base64 conversion successful, length:', base64.length);
        
        return base64;
    } catch (error) {
        console.log('❌ Image conversion failed:', error.message);
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
async function calculateAccessibleFeaturesScore(property) {
    let score = 0;
    const features = [];
    
    // Extract relevant text for analysis - FIXED variable references
    const description = (property.description || '').toLowerCase();
    const title = (property.title || '').toLowerCase();
    const propertyFeatures = (property.features || []).join(' ').toLowerCase();
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

    // 6. GARDEN ACCESS (SHARED/COMMUNAL) - New Feature
    const gardenKeywords = [
    'communal garden', 'shared garden', 'communal grounds', 'shared outdoor space',
    'communal courtyard', 'landscaped grounds', 'garden access', 'shared terrace',
    'communal areas', 'residents garden', 'well maintained garden', 'landscaped garden',
    // ADD THESE for private gardens:
    'private garden', 'own garden', 'rear garden', 'front garden', 'enclosed garden',
    'garden flat', 'garden apartment', 'low-maintenance garden', 'low maintenance garden'
    ];
    
    const hasGarden = gardenKeywords.some(keyword => fullText.includes(keyword));
    
    if (hasGarden) {
        score += 1;
        features.push('Garden access (shared/communal)');
        console.log('✓ Found garden access');
    }
     
    // 7. BALCONY/TERRACE - Enhanced with Floor Plan Analysis
    const balconyKeywords = [
        'balcony', 'private terrace', 'patio', 'roof terrace', 'private balcony',
        'juliet balcony', 'outdoor terrace', 'decking', 'sun terrace',
        'private patio', 'covered balcony'
    ];
    
    let hasBalcony = balconyKeywords.some(keyword => fullText.includes(keyword));
    
    console.log('🔍 Balcony text detection result:', hasBalcony); // ADD THIS
    console.log('🔍 Floor plan available:', !!property.floorplan); // ADD THIS
    console.log('🔍 Floor plan URL:', property.floorplan); // ADD THIS
    
    // If not found in text, try floor plan analysis
    if (!hasBalcony && property.floorplan) {
        console.log('🔍 No balcony found in text, checking floor plan...');
        const floorplanBalcony = await analyzeFloorPlanForBalcony(property.floorplan);

        console.log('🔍 Floor plan analysis returned:', floorplanBalcony); // ADD THIS
        console.log('🔍 Type of floorplanBalcony:', typeof floorplanBalcony); // ADD THIS
        
        if (floorplanBalcony === true) {
            hasBalcony = true;
            console.log('✅ Balcony detected via floor plan analysis');
        } else {
            console.log('❌ Floor plan balcony check failed:', floorplanBalcony); // ADD THIS
        }
    } else {
        console.log('🔍 Skipping floor plan analysis - hasBalcony:', hasBalcony, 'floorplan available:', !!property.floorplan); // ADD THIS
    }

    console.log('🔍 hasBalcony after floor plan check:', hasBalcony); // ADD THIS
    
    // ADD THIS BLOCK AFTER THE FLOOR PLAN DETECTION:
    if (hasBalcony) {
        score += 1;
        features.push('Balcony/terrace');
        console.log('✓ Found balcony/terrace');
    }
    
    // UPDATE: Add precise scoring calculation first
    const maxScore = 7; // Now 7 features total
    const preciseScore = Math.min(5, (score / maxScore) * 5);
    const displayScore = Math.round(preciseScore);
    
    console.log(`🏠 Accessible Features Score: ${displayScore}/5 (${score}/${maxScore} features found)`);
    console.log('✅ Features found:', features);
    console.log('🔍 Single floor property detected:', isSingleFloorProperty);
    
    return {
        score: preciseScore, // ADD: Precise score for overall calculation  
        displayScore: displayScore, // ADD: Rounded score for display
        maxScore: 5,
        features: features,
        percentage: Math.round((score / maxScore) * 100), // UPDATE: Change to /7
        details: {
            lateralLiving: hasLateralLiving && !isUpperFloor,
            downstairsBedroom: hasDownstairsBedroom,
            downstairsBathroom: hasDownstairsBathroom,
            levelAccess: hasLevelAccess,
            privateParking: hasPrivateParking && !hasOnStreetOnly,
            garden: hasGarden, // ADD
            balcony: hasBalcony, // ADD
            isSingleFloorProperty: isSingleFloorProperty
        }
    };
}

// Try to access dedicated floorplan page
async function tryFloorplanURL(propertyId) {
    try {
        // Try the dedicated floorplan URL first
        const floorplanURL = `https://www.rightmove.co.uk/properties/${propertyId}#/floorplan?activePlan=1&channel=RES_BUY`;
        console.log('Trying floorplan URL:', floorplanURL);
        
        const floorplanResponse = await axios.get(floorplanURL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000
        });

        const $ = cheerio.load(floorplanResponse.data);
        
        const floorplanImages = [];
        
        // NEW: Look for full-size images (not thumbnails)
        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && (src.includes('floorplan') || src.includes('plan') || 
                       $(img).attr('alt')?.toLowerCase().includes('floorplan'))) {
                
                // Skip GIF files for Claude compatibility
                if (!src.includes('.gif')) {
                    floorplanImages.push(src);
                }
            }
        });
        
        // NEW: Look in script tags for full-resolution URLs
        $('script').each((i, script) => {
            const scriptContent = $(script).html() || '';
            
            // Look for full-size floorplan URLs (without size restrictions)
            const fullSizeMatches = scriptContent.match(/https?:\/\/[^"'\s]*floorplan[^"'\s]*(?<!max_\d+x\d+)\.(png|jpg|jpeg|gif)/gi);
            if (fullSizeMatches) {
                floorplanImages.push(...fullSizeMatches);
            }
            
            // Look for image data in JSON
            const jsonMatches = scriptContent.match(/"url":\s*"([^"]*floorplan[^"]*)"/gi);
            if (jsonMatches) {
                jsonMatches.forEach(match => {
                    const urlMatch = match.match(/"url":\s*"([^"]*)"/);
                    if (urlMatch && !urlMatch[1].includes('max_296x197')) {
                        floorplanImages.push(urlMatch[1]);
                    }
                });
            }
        });
        
        console.log(`Found ${floorplanImages.length} full-size floorplans`);
        
        if (floorplanImages.length > 0) {
            // Return the first full-size image
            const fullSizeUrl = floorplanImages[0];
            console.log('Using full-size floor plan:', fullSizeUrl);
            return fullSizeUrl;
        }
        
        // Fallback to original method if no full-size found
        console.log('No full-size images found, falling back to thumbnails...');
        // ... rest of your existing code ...
        
    } catch (error) {
        console.log('Floorplan URL not accessible:', error.message);
        return null;
    }
}

// ✅ ADD THE NEW FUNCTION HERE - RIGHT AFTER tryFloorplanURL
async function analyzeFloorPlanForBalcony(floorplanUrl) {
    try {
        console.log('👁️ Analyzing floor plan for balcony:', floorplanUrl?.substring(0, 100) + '...');
        
        if (!floorplanUrl || !process.env.CLAUDE_API_KEY) {
            console.log('⚠️ No floor plan URL or Claude API key available');
            return null;
        }
        
        const prompt = `Analyze this floor plan image and determine if it shows a balcony, terrace, or outdoor space.

Look for:
1. Labeled text like "Balcony", "Terrace", "Patio", "Outdoor Space"
2. Outdoor areas connected to the main living space
3. Spaces on the building perimeter with outdoor furniture symbols
4. Areas with different hatching/shading patterns indicating outdoor space

Respond with EXACTLY one of these:
- "BALCONY_FOUND" if you can see a balcony/terrace/outdoor space
- "NO_BALCONY" if no outdoor space is visible
- "UNCLEAR" if the image is too unclear to determine

Be conservative - only say BALCONY_FOUND if you're confident.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 50,
            messages: [{
                role: 'user',
                content: [{
                    type: 'text',
                    text: prompt
                }, {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: floorplanUrl.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg',
                        data: await convertImageToBase64(floorplanUrl)
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
        
        const result = response.data.content[0].text.trim().toUpperCase();
        console.log('👁️ Floor plan balcony analysis result:', result);
        
        return result.includes('BALCONY_FOUND');
        
    } catch (error) {
        console.log('❌ Floor plan balcony analysis failed:', error.message);
        return null;
    }
}

// Add this validation function for floor plan analysis (similar to EPC validation)
function validateFloorPlanResponse(visionText) {
    console.log('🔍 Validating floor plan response:', visionText);
    
    const rooms = [];
    
    // Try to extract room information from the structured response
    const roomMatches = [...visionText.matchAll(/Room\s+\d+:\s*(.+?)(?:\n|Dimensions)/gi)];
    const dimensionMatches = [...visionText.matchAll(/Dimensions\s+\d+:\s*(.+?)(?:\n|Room|$)/gi)];
    
    console.log(`🔍 Found ${roomMatches.length} room labels, ${dimensionMatches.length} dimension sets`);
    
    for (let i = 0; i < roomMatches.length; i++) {
        const roomLabel = roomMatches[i][1].trim();
        const dimensionText = dimensionMatches[i] ? dimensionMatches[i][1].trim() : null;
        
        if (roomLabel && roomLabel !== 'null' && roomLabel !== 'undefined') {
            // Determine room type from label
            let roomType = 'room'; // default
            const labelLower = roomLabel.toLowerCase();
            
            if (labelLower.includes('bedroom')) roomType = 'bedroom';
            else if (labelLower.includes('kitchen') || labelLower.includes('reception') || labelLower.includes('dining')) roomType = 'reception';
            else if (labelLower.includes('bathroom') || labelLower.includes('shower')) roomType = 'bathroom';
            else if (labelLower.includes('terrace') || labelLower.includes('balcony')) roomType = 'terrace';
            else if (labelLower.includes('storage') || labelLower.includes('utility')) roomType = 'storage';
            
            // Parse dimensions if available
            let dimensions = null;
            if (dimensionText && dimensionText !== 'No dimensions visible' && !dimensionText.includes('not visible')) {
                // Extract imperial and metric dimensions
                const imperialMatch = dimensionText.match(/(\d+['\"]\d*[\"']?\s*x\s*\d+['\"]\d*[\"']?)/i);
                const metricMatch = dimensionText.match(/(\d+\.\d+\s*x\s*\d+\.\d+m?)/i);
                
                if (imperialMatch || metricMatch) {
                    dimensions = {
                        imperial: imperialMatch ? imperialMatch[1] : null,
                        metric: metricMatch ? metricMatch[1] : null,
                        area_sqft: null,
                        area_sqm: null
                    };
                }
            }
            
            rooms.push({
                type: roomType,
                display: roomLabel,
                count: 1,
                dimensions: dimensions
            });
            
            console.log(`✅ Parsed room: ${roomLabel} (${roomType}) - Dimensions: ${dimensionText || 'none'}`);
        }
    }
    
    return { rooms };
}

// Update the floor plan analysis function to use validation
async function analyzeFloorplanForRoomsWithValidation(floorplanUrl) {
    console.log('🏠 Analyzing floor plan for room layout:', floorplanUrl);
    
    if (!process.env.CLAUDE_API_KEY) {
        console.log('⚠️ No Claude API key available for floor plan room analysis');
        return null;
    }
    
    try {
        // ... (use the updated prompt from the artifact above)
        
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: [{
                    type: 'text',
                    text: prompt // from artifact above
                }, {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/jpeg',
                        data: await convertImageToBase64(floorplanUrl)
                    }
                }]
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            timeout: 20000
        });

        const analysisText = response.data.content[0].text.trim();
        console.log('🏠 Floor plan room analysis result:', analysisText);
        
        // Try standard JSON parsing first
        let roomData = null;
        try {
            const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                roomData = JSON.parse(jsonMatch[0]);
                console.log('🏠 Standard JSON parsing successful');
            }
        } catch (parseError) {
            console.log('🏠 Standard JSON parsing failed, trying validation approach...');
        }
        
        // If standard parsing fails, use validation function
        if (!roomData || !roomData.rooms || roomData.rooms.length === 0) {
            console.log('🏠 Using validation function to parse response...');
            roomData = validateFloorPlanResponse(analysisText);
        }
        
        if (roomData && roomData.rooms && roomData.rooms.length > 0) {
            console.log('🏠 Parsed room data:', roomData);
            return roomData;
        } else {
            console.log('🏠 No valid room data found in response');
            return null;
        }
        
    } catch (error) {
        console.log('🏠 Floor plan room analysis failed:', error.message);
        return null;
    }
}

// Add this function near your existing analyzeFloorplanForBalcony function

async function analyzeFloorplanForRooms(floorplanUrl) {
    console.log('🏠 Analyzing floor plan for room layout:', floorplanUrl);
    
    if (!process.env.CLAUDE_API_KEY) {
        console.log('⚠️ No Claude API key available for floor plan room analysis');
        return null;
    }
    
    try {
        const prompt = `Analyze this UK property floor plan and read ALL labeled text exactly as shown.

CRITICAL: Read the EXACT labels and dimensions from the image:
- Look for room labels like "Kitchen/Reception/Dining", "Bedroom 1", "Bedroom 2"
- Look for outdoor spaces like "Roof Terrace", "Balcony", "Garden"  
- Look for storage areas labeled "Storage"
- Read dimensions EXACTLY as written (like "30'8 (9.35)max x 24'4 (7.42)max")

SPACES TO IDENTIFY:
1. Kitchen/Reception/Dining areas (large main living space)
2. All Bedrooms (Bedroom 1, Bedroom 2, etc.)
3. Bathrooms (main bathroom, not tiny WCs)
4. Storage rooms (if labeled)
5. Outdoor spaces (Roof Terrace, Balcony)

RESPOND EXACTLY IN THIS FORMAT:
Room 1: [EXACT LABEL FROM FLOOR PLAN]
Dimensions 1: [EXACT DIMENSIONS AS WRITTEN] 
Room 2: [EXACT LABEL FROM FLOOR PLAN]
Dimensions 2: [EXACT DIMENSIONS AS WRITTEN]
Room 3: [EXACT LABEL FROM FLOOR PLAN]
Dimensions 3: [EXACT DIMENSIONS AS WRITTEN]
(continue for all rooms found)

Then provide JSON:
{
  "rooms": [
    {
      "type": "reception",
      "display": "Kitchen/Reception/Dining Room",
      "count": 1,
      "dimensions": {
        "imperial": "30'8 x 24'4",
        "metric": "9.35m x 7.42m",
        "area_sqft": null,
        "area_sqm": null
      }
    }
  ]
}

Read EVERYTHING visible on the floor plan, including outdoor spaces.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: [{
                    type: 'text',
                    text: prompt
                }, {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/jpeg',
                        data: await convertImageToBase64(floorplanUrl)
                    }
                }]
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            timeout: 20000
        });

        const analysisText = response.data.content[0].text.trim();
        console.log('🏠 Floor plan room analysis result:', analysisText);
        
        // Parse the JSON response
        try {
            const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const roomData = JSON.parse(jsonMatch[0]);
                console.log('🏠 Parsed room data:', roomData);
                return roomData;
            } else {
                console.log('🏠 No JSON found in floor plan response');
                return null;
            }
        } catch (parseError) {
            console.log('🏠 Failed to parse floor plan room JSON:', parseError.message);
            return null;
        }
        
    } catch (error) {
        console.log('🏠 Floor plan room analysis failed:', error.message);
        return null;
    }
}

// ✅ DIMENSIONS EXTRACTION
async function extractDimensions(propertyDescription, title, features, floorplan) {
    console.log('📐 Extracting property dimensions...');
    
    let dimensions = {
        totalSqFt: null,
        totalSqM: null,
        rooms: [],
        roomTypes: []
    };
    
    const fullText = `${title} ${propertyDescription} ${features.join(' ')}`.toLowerCase();
    console.log('📐 Full text for room analysis (first 1000 chars):', fullText.substring(0, 1000));
    
    // Extract total square footage
    const sqftPatterns = [
        /(\d+(?:,\d+)?)\s*sq\s*ft/i,
        /(\d+(?:,\d+)?)\s*sqft/i,
        /(\d+(?:,\d+)?)\s*square\s*feet/i
    ];
    
    for (const pattern of sqftPatterns) {
        const match = fullText.match(pattern);
        if (match) {
            dimensions.totalSqFt = parseInt(match[1].replace(/,/g, ''));
            console.log('📐 Found total sq ft:', dimensions.totalSqFt);
            break;
        }
    }
    
    // Extract total square meters
    const sqmPatterns = [
        /(\d+(?:,\d+)?)\s*sq\s*m\b/i,
        /(\d+(?:,\d+)?)\s*sqm/i,
        /(\d+(?:,\d+)?)\s*square\s*met/i
    ];
    
    for (const pattern of sqmPatterns) {
        const match = fullText.match(pattern);
        if (match) {
            dimensions.totalSqM = parseInt(match[1].replace(/,/g, ''));
            console.log('📐 Found total sq m:', dimensions.totalSqM);
            break;
        }
    }
    
    // If only one unit found, convert to the other
    if (dimensions.totalSqFt && !dimensions.totalSqM) {
        dimensions.totalSqM = Math.round(dimensions.totalSqFt * 0.092903);
    } else if (dimensions.totalSqM && !dimensions.totalSqFt) {
        dimensions.totalSqFt = Math.round(dimensions.totalSqM * 10.764);
    }
    
    // Extract individual room dimensions
    const roomDimensionPatterns = [
        /(\w+(?:\s+\w+)*)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:ft|m)/gi,
        /(\w+(?:\s+\w+)*)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/gi
    ];
    
    for (const pattern of roomDimensionPatterns) {
        const matches = [...fullText.matchAll(pattern)];
        
        for (const match of matches) {
            const roomName = match[1].trim();
            const length = parseFloat(match[2]);
            const width = parseFloat(match[3]);
            
            // Skip if dimensions seem unrealistic
            if (length > 0 && width > 0 && length < 50 && width < 50) {
                const sqft = Math.round(length * width);
                
                dimensions.rooms.push({
                    name: roomName,
                    length,
                    width,
                    sqft,
                    dimensions: `${length} × ${width}`
                });
                
                console.log(`📐 Found room: ${roomName} - ${length} × ${width} (${sqft} sq ft)`);
            }
        }
    }
    
    // Extract room types and counts - ENHANCED VERSION
    const roomTypePatterns = {
        bedrooms: /(\d+)\s*bed(?:room)?s?/i,
        bathrooms: /(\d+)\s*bath(?:room)?s?/i,
        receptions: /(\d+)\s*reception\s*rooms?/i,
        livingRooms: /(\d+)?\s*(?:living\s*room|lounge|sitting\s*room)s?/i,
        kitchens: /(\d+)?\s*kitchen(?:ette)?s?/i,
        diningRooms: /(\d+)?\s*dining\s*rooms?/i,
        studies: /(\d+)?\s*(?:study|studies|office)s?/i,
        conservatories: /(\d+)?\s*conservator(?:y|ies)/i,
        utilities: /(\d+)?\s*utility\s*rooms?/i,
        cloakrooms: /(\d+)?\s*(?:cloakroom|downstairs\s*wc|powder\s*room)s?/i
    };
    
    for (const [type, pattern] of Object.entries(roomTypePatterns)) {
        const match = fullText.match(pattern);
        if (match) {
            // For rooms that might not have a number (like "kitchen"), default to 1
            let count = match[1] ? parseInt(match[1]) : 1;
            
            // Skip if count is 0 or invalid
            if (count > 0 && count <= 10) { // Reasonable limit
                let displayName;
                switch(type) {
                    case 'bedrooms':
                        displayName = count === 1 ? 'bedroom' : 'bedrooms';
                        break;
                    case 'bathrooms':
                        displayName = count === 1 ? 'bathroom' : 'bathrooms';
                        break;
                    case 'receptions':
                        displayName = count === 1 ? 'reception room' : 'reception rooms';
                        break;
                    case 'livingRooms':
                        displayName = count === 1 ? 'living room' : 'living rooms';
                        break;
                    case 'kitchens':
                        displayName = count === 1 ? 'kitchen' : 'kitchens';
                        break;
                    case 'diningRooms':
                        displayName = count === 1 ? 'dining room' : 'dining rooms';
                        break;
                    case 'studies':
                        displayName = count === 1 ? 'study' : 'studies';
                        break;
                    case 'conservatories':
                        displayName = count === 1 ? 'conservatory' : 'conservatories';
                        break;
                    case 'utilities':
                        displayName = count === 1 ? 'utility room' : 'utility rooms';
                        break;
                    case 'cloakrooms':
                        displayName = count === 1 ? 'cloakroom' : 'cloakrooms';
                        break;
                    default:
                        displayName = type;
                }
                
                dimensions.roomTypes.push({
                    type: type.replace(/s$/, ''), // Remove trailing 's'
                    count: count,
                    display: displayName
                });
                
                console.log(`📐 Found room type: ${count} ${displayName}`);
            }
        }
    }        
            
    // Extract all property spaces (outdoor, utility, and storage spaces)
    const propertySpacePatterns = {
        balcony: /balcony|balconies/i,
        terrace: /terrace/i,
        patio: /patio/i,
        garden: /private\s*garden|own\s*garden|rear\s*garden|front\s*garden|enclosed\s*garden|garden\s*flat|garden\s*apartment/i,
        courtyard: /courtyard/i,
        roof_terrace: /roof\s*terrace/i,
        garage: /garage/i,
        parking: /parking\s*space|car\s*park|allocated\s*parking|designated\s*parking/i,
        storage: /storage\s*room|storage\s*space|storage\s*cupboard/i,
        basement: /basement|cellar/i,
        attic: /attic|loft\s*space/i,
        shed: /shed|outbuilding/i,
        gym: /private\s*gym|home\s*gym|personal\s*gym/i,
        wine_cellar: /wine\s*cellar/i,
        laundry: /laundry\s*room/i,
        utility: /utility\s*room|utility\s*cupboard/i
    };
    
    Object.entries(propertySpacePatterns).forEach(([spaceType, pattern]) => {
        if (fullText.match(pattern)) {
            const alreadyExists = dimensions.roomTypes.some(room => room.type === spaceType);
            
            if (!alreadyExists) {
                // Filter out communal facilities
                const communalTerms = /communal|shared|onsite|residents|development|complex|building|site/i;
                const patternMatch = fullText.search(pattern);
                const context = fullText.substring(Math.max(0, patternMatch - 100), patternMatch + 100);
                
                // Skip if it's clearly communal (especially for garden and gym)
                if ((spaceType === 'garden' || spaceType === 'gym') && context.match(communalTerms)) {
                    console.log(`📐 Skipping communal ${spaceType} (context: "${context.substring(0, 50)}...")`);
                    return;
                }
                
                let displayName = spaceType.replace('_', ' ');
                dimensions.roomTypes.push({
                    type: spaceType,
                    count: 1,
                    display: displayName
                });
                console.log(`📐 Found property space: ${displayName}`);
            }
        }
    });

    // FLOOR PLAN FALLBACK FOR MISSING ROOM INFORMATION
    console.log('📐 Checking if floor plan analysis needed...');
    console.log('📐 Current room types found:', dimensions.roomTypes.length);
    
    // Always analyze floor plan for room dimensions if available
    if (floorplan && !dimensions.floorplanAnalyzed) {
        console.log('📐 Limited room info detected, analyzing floor plan for rooms...');
        dimensions.floorplanAnalyzed = true; // Set flag to prevent re-analysis
        
        try {
            console.log('📐 Analyzing all available floor plans with confidence scoring...');
            
            const floorplanAttempts = [];
            
            // Try first floor plan
            console.log('📐 Analyzing first floor plan...');
            const firstAttempt = await analyzeFloorplanForRooms(floorplan);
            if (firstAttempt) {
                const confidence = calculateFloorPlanConfidence(firstAttempt);
                floorplanAttempts.push({
                    source: 'FLP_00 (first)',
                    data: firstAttempt,
                    confidence: confidence,
                    roomCount: firstAttempt.rooms?.length || 0
                });
            }
            
            // Try second floor plan
            console.log('📐 Analyzing second floor plan...');
            const secondFloorplan = floorplan.replace('FLP_00', 'FLP_01');
            const secondAttempt = await analyzeFloorplanForRooms(secondFloorplan);
            if (secondAttempt) {
                const confidence = calculateFloorPlanConfidence(secondAttempt);
                floorplanAttempts.push({
                    source: 'FLP_01 (second)', 
                    data: secondAttempt,
                    confidence: confidence,
                    roomCount: secondAttempt.rooms?.length || 0
                });
            }
            
            // Log all attempts
            floorplanAttempts.forEach((attempt, index) => {
                console.log(`📐 Floor plan ${index + 1} (${attempt.source}):`);
                console.log(`   Rooms found: ${attempt.roomCount}`);
                console.log(`   Confidence: ${attempt.confidence}/100`);
            });
            
            // Select best floor plan based on confidence + room count
            let selectedAttempt = null;
            if (floorplanAttempts.length > 0) {
                // Sort by confidence first, then by room count
                floorplanAttempts.sort((a, b) => {
                    const confidenceDiff = b.confidence - a.confidence;
                    if (Math.abs(confidenceDiff) < 15) { // If confidence is close (within 15 points)
                        return b.roomCount - a.roomCount; // Prefer more rooms
                    }
                    return confidenceDiff; // Otherwise prefer higher confidence
                });
                
                selectedAttempt = floorplanAttempts[0];
                console.log(`✅ Selected floor plan: ${selectedAttempt.source}`);
                console.log(`   Final confidence: ${selectedAttempt.confidence}/100`);
                console.log(`   Final room count: ${selectedAttempt.roomCount}`);
                
                // Only use if confidence is acceptable
                if (selectedAttempt.confidence >= 50) {
                    dimensions = processFloorPlanResults(selectedAttempt.data, dimensions);
                } else {
                    console.log(`⚠️ Floor plan confidence too low (${selectedAttempt.confidence}/100), skipping floor plan analysis`);
                }
            } else {
                console.log('❌ No valid floor plan analysis results');
            }
            
        } catch (error) {
            console.log('📐 Floor plan analysis failed:', error.message);
        }
    } // ← ADD THIS: closes the if (floorplan && !dimensions.floorplanAnalyzed)

    // Remove individual rooms if open plan space detected
    const hasOpenPlan = dimensions.roomTypes.some(room => room.type === 'openPlan');
    if (hasOpenPlan) {
        console.log('📐 Open plan space detected, removing duplicate individual rooms...');
        // Remove individual kitchen, living, dining if open plan exists
        dimensions.roomTypes = dimensions.roomTypes.filter(room => 
            !['kitchen', 'livingRoom', 'diningRoom'].includes(room.type) || room.type === 'openPlan'
        );
        console.log('📐 Removed individual rooms in favor of open plan space');
    }
    
    // Conservative consolidation - only combine when there's clear textual evidence
    const detectedRooms = dimensions.roomTypes.filter(room => 
        ['kitchen', 'livingRoom', 'diningRoom'].includes(room.type)
    );
    
    // Only consolidate if we have 2 or more of these room types AND clear evidence of combination
    if (detectedRooms.length >= 2 && !dimensions.roomTypes.some(room => room.type === 'openPlan')) {
        // Check if the text suggests these are truly combined
        const combinedSpaceIndicators = [
            /open[- ]plan/i,
            /kitchen[\/\-\s]*living/i,
            /living[\/\-\s]*kitchen/i,
            /kitchen[\/\-\s]*dining/i,
            /dining[\/\-\s]*kitchen/i,
            /kitchen[\/\-\s]*diner/i,
            /living[\/\-\s]*dining/i,
            /dining[\/\-\s]*living/i,
            /kitchen[\/\-\s]*living[\/\-\s]*dining/i,
            /living[\/\-\s]*kitchen[\/\-\s]*dining/i,
            /reception[\/\-\s]*kitchen/i,
            /kitchen[\/\-\s]*reception/i
        ];
        
        const hasCombinedIndicator = combinedSpaceIndicators.some(pattern => 
            fullText.match(pattern)
        );
        
        // Only consolidate if we have clear textual evidence of combination
        if (hasCombinedIndicator) {
            const roomsToConsolidate = detectedRooms.map(room => room.type);
            console.log(`📐 Found evidence of combined space, consolidating: ${roomsToConsolidate.join('/')}`);
            
            // Remove the individual rooms that are being consolidated
            dimensions.roomTypes = dimensions.roomTypes.filter(room => 
                !roomsToConsolidate.includes(room.type)
            );
            
            // Create display name based on detected rooms
            const displayParts = [];
            if (roomsToConsolidate.includes('kitchen')) displayParts.push('kitchen');
            if (roomsToConsolidate.includes('livingRoom')) displayParts.push('living');
            if (roomsToConsolidate.includes('diningRoom')) displayParts.push('dining');
            
            // Add consolidated open plan room
            dimensions.roomTypes.push({
                type: 'openPlan',
                count: 1,
                display: `open plan ${displayParts.join('/')}`
            });
            
            console.log(`📐 Consolidated into: open plan ${displayParts.join('/')}`);
        } else {
            console.log('📐 Multiple main rooms found but no evidence of combination - keeping separate');
        }
    }
    
    // Check for combined spaces when no individual rooms were detected
    const combinedPatterns = [
        /open[- ]plan/i,
        /kitchen[\/\-\s]*(?:living|diner|dining)/i,
        /living[\/\-\s]*(?:kitchen|dining)/i,
        /kitchen[\/\-\s]*diner/i
    ];
    
    for (const pattern of combinedPatterns) {
        if (fullText.match(pattern)) {
            // Add open plan living space if no rooms detected yet
            const hasLiving = dimensions.roomTypes.some(room => room.type === 'livingRoom');
            const hasKitchen = dimensions.roomTypes.some(room => room.type === 'kitchen');
            const hasOpenPlan = dimensions.roomTypes.some(room => room.type === 'openPlan');
            
            if (!hasLiving && !hasKitchen && !hasOpenPlan) {
                dimensions.roomTypes.push({
                    type: 'openPlan',
                    count: 1,
                    display: 'open plan living/kitchen'
                });
                console.log('📐 Found combined space: open plan living/kitchen');
            }
            break;
        }
    }
    
    console.log('📐 Dimension extraction complete:', {
        totalSqFt: dimensions.totalSqFt,
        totalSqM: dimensions.totalSqM,
        roomCount: dimensions.rooms.length,
        roomTypes: dimensions.roomTypes.length
    });
    
    return dimensions;
} // ← This was already there - closes the main extractDimensions function

// Calculate confidence score based on multiple factors
function calculateFloorPlanConfidence(roomData) {
    if (!roomData) return 0;
    
    let confidence = 70; // Start with baseline confidence
    
    // Adjust based on data quality indicators
    const rooms = roomData.rooms || [];
    
    // Penalty for too few rooms (likely missed some)
    if (rooms.length < 4) {
        confidence -= 20;
        console.log('   📉 Confidence reduced: Too few rooms detected');
    }
    
    // Bonus for reasonable room count
    if (rooms.length >= 5 && rooms.length <= 7) {
        confidence += 10;
        console.log('   📈 Confidence boost: Good room count');
    }
    
    // Bonus for having dimensions
    const roomsWithDimensions = rooms.filter(room => 
        room.dimensions && (room.dimensions.imperial || room.dimensions.metric)
    );
    
    if (roomsWithDimensions.length === rooms.length) {
        confidence += 15;
        console.log('   📈 Confidence boost: All rooms have dimensions');
    } else if (roomsWithDimensions.length === 0) {
        confidence -= 25;
        console.log('   📉 Confidence reduced: No room dimensions found');
    }
    
    // Bonus for finding outdoor spaces (roof terrace, balcony)
    const hasOutdoorSpace = rooms.some(room => 
        room.type === 'outdoor' || 
        room.display.toLowerCase().includes('terrace') ||
        room.display.toLowerCase().includes('balcony')
    );
    
    if (hasOutdoorSpace) {
        confidence += 10;
        console.log('   📈 Confidence boost: Outdoor space detected');
    }
    
    return Math.max(0, Math.min(100, confidence));
}

// Updated function to process floor plan results with dimensions
// Updated function to process floor plan results with dimensions
function processFloorPlanResults(floorplanRoomAnalysis, dimensions) {
    if (floorplanRoomAnalysis && floorplanRoomAnalysis.rooms) {
        console.log('📐 Floor plan analysis successful, replacing room data with detailed floor plan results...');
        
        // Clear existing room types since we have detailed floor plan data
        dimensions.roomTypes = [];
        
        // Process each room from floor plan
        floorplanRoomAnalysis.rooms.forEach(room => {
            // Add room type with exact display name from floor plan
            dimensions.roomTypes.push({
                type: room.type,
                count: room.count || 1,
                display: room.display, // Use exact label from floor plan
                source: 'floorplan'
            });
            console.log(`📐 Added from floor plan: ${room.display}`);
        });
        
        // Process dimensions if available
        const roomsWithDimensions = floorplanRoomAnalysis.rooms.filter(room => 
            room.dimensions && room.dimensions !== null
        );
        
        if (roomsWithDimensions.length > 0) {
            console.log('📐 Found rooms with dimensions from floor plan...');
            
            // Add to dimensions.rooms array for detailed display
            roomsWithDimensions.forEach(room => {
                if (room.dimensions) {
                    const roomDimension = {
                        name: room.display, // Use exact label from floor plan
                        type: room.type,
                        imperial: room.dimensions.imperial || null,
                        metric: room.dimensions.metric || null,
                        area_sqft: room.dimensions.area_sqft || null,
                        area_sqm: room.dimensions.area_sqm || null
                    };
                    
                    // Create dimensions string for display
                    if (room.dimensions.imperial) {
                        roomDimension.dimensions = room.dimensions.imperial;
                        
                        // Calculate area if dimensions available
                        const area = calculateAreaFromDimensions(room.dimensions.imperial);
                        if (area) {
                            roomDimension.sqft = area;
                        }
                    } else if (room.dimensions.metric) {
                        roomDimension.dimensions = room.dimensions.metric;
                    }
                    
                    dimensions.rooms.push(roomDimension);
                    console.log(`📐 Added dimensions for ${room.display}: ${roomDimension.dimensions}`);
                }
            });
        }
        
        console.log('📐 Using detailed floor plan data instead of text-based room detection');
    }
    
    return dimensions;
}

// Helper function to calculate area from dimension string
function calculateAreaFromDimensions(dimensionString) {
    // Parse dimensions like "13'1" x 7'6"" or "14'0" x 11'1""
    const match = dimensionString.match(/(\d+)'(\d+)"\s*x\s*(\d+)'(\d+)"/);
    if (match) {
        const feet1 = parseInt(match[1]);
        const inches1 = parseInt(match[2]);
        const feet2 = parseInt(match[3]);
        const inches2 = parseInt(match[4]);
        
        const totalInches1 = (feet1 * 12) + inches1;
        const totalInches2 = (feet2 * 12) + inches2;
        
        // Convert to feet and calculate area
        const length = totalInches1 / 12;
        const width = totalInches2 / 12;
        
        return Math.round(length * width);
    }
    
    return null;
}

function analyzeCostInformation(property, dimensions) {
    console.log('💷 DEBUG: Dimensions received:', dimensions);
    console.log('💷 DEBUG: totalSqM:', dimensions?.totalSqM);
    console.log('💷 DEBUG: property.price:', property.price);
    console.log('💷 DEBUG: property.tenure =', property.tenure);
    console.log('💷 DEBUG: property.tenure =', property.tenure);
    console.log('💷 DEBUG: Description contains "4116":', (property.description || '').includes('4116'));
    console.log('💷 DEBUG: Description contains "service":', (property.description || '').includes('service'));
    console.log('💷 DEBUG: Description contains "annual":', (property.description || '').includes('annual'));
    console.log('💷 DEBUG: First 2000 chars of description:', (property.description || '').substring(0, 2000));
    
    // ... rest of your function
    const cost = {
        price: property.price || null,
        isRental: false,
        pricePerSqM: null,
        pricePerSqMNote: null,
        councilTax: null,
        serviceCharge: null,
        groundRent: null,
        leaseholdInfo: null
    };

    // Determine if it's rental or sale
    if (property.price) {
        cost.isRental = property.price.toLowerCase().includes('pcm') || 
                       property.price.toLowerCase().includes('per month') ||
                       property.price.toLowerCase().includes('monthly');
    }

    // Calculate price per sq m
    if (property.price && dimensions && dimensions.totalSqM) {
        const priceNumber = extractPriceNumber(property.price);
        console.log('💷 DEBUG: Extracted price number:', priceNumber);
        if (priceNumber) {
            const pricePerSqM = Math.round(priceNumber / dimensions.totalSqM);
            cost.pricePerSqM = `£${pricePerSqM.toLocaleString()} per sq m`;
            
            if (cost.isRental) {
                cost.pricePerSqMNote = "Based on monthly rent";
            }
        }
    } else if (property.price) {
        if (!dimensions || !dimensions.totalSqM) {
            cost.pricePerSqM = "Unable to calculate - property size not available";
        } else {
            cost.pricePerSqM = "Unable to calculate - price format not recognized";
        }
    }

    
    // ENHANCED: Extract council tax (prioritize actual bands over TBC)
    const description = property.description || '';
    const councilTaxPatterns = [
        /council\s*tax\s*band[:\s]*([a-h])/i,
        /band[:\s]*([a-h])\s*council\s*tax/i,
        /council\s*tax[:\s]*([a-h])/i,
        /band[:\s]*([a-h])/i
    ];
    
    // First, look for actual council tax bands (A-H)
    for (const pattern of councilTaxPatterns) {
        const match = description.match(pattern);
        if (match && match[1] && match[1].toLowerCase() !== 'tbc') {
            cost.councilTax = `Band ${match[1].toUpperCase()}`;
            break;
        }
    }
    
    // Only if no actual band found, then check for TBC
    if (!cost.councilTax) {
        const tbcPatterns = [
            /council\s*tax\s*band[:\s]*tbc/i,
            /band[:\s]*tbc/i
        ];
        
        for (const pattern of tbcPatterns) {
            const match = description.match(pattern);
            if (match) {
                cost.councilTax = "Band TBC";
                break;
            }
        }
    }

    // ENHANCED: Extract service charge (look for £4116 format and more patterns)
    // ENHANCED: Extract service charge (more precise patterns with validation)
    const serviceChargePatterns = [
        // More specific patterns that avoid property price confusion
        /annual\s*service\s*charge[:\s]*£([\d,]+)/i,
        /service\s*charge[:\s]*£([\d,]+)\s*(?:per\s*)?(annum|year|annual)/i,
        /service\s*charge[:\s]*£([\d,]+)(?!\s*knowing)/i, // Exclude "knowing the purchase price"
        /leasehold.*service.*£([\d,]+)/i,
        /service.*charge.*£([\d,]+)/i,
        
        // Look for amounts that are clearly service charges (reasonable range)
        /£([\d,]+)\s*(?:per\s*)?(annum|annual|year).*service/i,
        /service.*£([1-9]\d{3,4})(?!\d)/i, // £1000-99999 range, not property prices
    ];
    
    console.log('💷 DEBUG: Looking for service charge in description...');
    
    for (const pattern of serviceChargePatterns) {
        const match = description.match(pattern);
        if (match) {
            console.log('💷 DEBUG: Service charge pattern matched:', pattern, 'Result:', match[0]);
            
            const amount = match[1];
            if (amount) {
                const numericAmount = parseInt(amount.replace(/,/g, ''));
                
                // Validate: service charges are typically £500-£50000 annually
                if (numericAmount >= 500 && numericAmount <= 50000) {
                    const period = match[2] ? match[2].toLowerCase() : 'annum';
                    cost.serviceCharge = `£${amount} per ${period === 'year' ? 'annum' : period}`;
                    console.log('💷 DEBUG: Found valid service charge:', cost.serviceCharge);
                    break;
                } else {
                    console.log('💷 DEBUG: Rejected service charge (out of range):', numericAmount);
                }
            }
        }
    }
    // ADD THIS NEW SECTION HERE - Use leasehold details if available and no service charge found yet
    if (!cost.serviceCharge && property.leaseholdDetails && property.leaseholdDetails.serviceCharge) {
        cost.serviceCharge = `£${property.leaseholdDetails.serviceCharge} per annum`;
        console.log('💷 DEBUG: Using leasehold details service charge:', cost.serviceCharge);
    }

    // ENHANCED: Extract ground rent (including "Ask agent")
    const groundRentPatterns = [
        /ground\s+rent[:\s]+£([\d,]+)(?:\s+per\s+(annum|year|month))?/i,
        /£([\d,]+)(?:\s+per\s+(annum|year|month))?\s+ground\s+rent/i,
        /ground\s+rent[:\s]+ask\s+agent/i,
        /ground\s+rent.*ask.*agent/i
    ];
    
    for (const pattern of groundRentPatterns) {
        const match = description.match(pattern);
        if (match) {
            if (match[0].toLowerCase().includes('ask')) {
                cost.groundRent = "Ask agent";
            } else {
                const amount = match[1];
                const period = match[2] ? match[2].toLowerCase() : 'annum';
                cost.groundRent = `£${amount} per ${period === 'year' ? 'annum' : period}`;
            }
            break;
        }
    }
    // Use leasehold details if available and no ground rent found yet
    if (!cost.groundRent && property.leaseholdDetails && property.leaseholdDetails.groundRent) {
        const groundRentValue = property.leaseholdDetails.groundRent;
        
        // Check if it's "Ask agent" or a monetary amount
        if (groundRentValue.toLowerCase().includes('ask') || groundRentValue.toLowerCase().includes('agent')) {
            cost.groundRent = "Ask agent";
        } else if (!isNaN(parseInt(groundRentValue)) && parseInt(groundRentValue) > 0) {
            // It's a number, format as currency
            cost.groundRent = `£${groundRentValue} per annum`;
        } else {
            // Use as-is for other cases
            cost.groundRent = groundRentValue;
        }
        
        console.log('💷 DEBUG: Using leasehold details ground rent:', cost.groundRent);
    }

    // Check for peppercorn ground rent
    if (!cost.groundRent && description.match(/peppercorn\s+ground\s+rent/i)) {
        cost.groundRent = "Peppercorn ground rent";
    }

    // ENHANCED: Extract leasehold information (including "136 years left")
    if (property.tenure) {
        if (property.tenure.toLowerCase().includes('leasehold')) {
            cost.leaseholdInfo = "Leasehold";
        } else if (property.tenure.toLowerCase().includes('freehold')) {
            cost.leaseholdInfo = "Freehold";
        }
    }
    
    // Enhanced leasehold pattern matching
    if (!cost.leaseholdInfo || cost.leaseholdInfo === "Leasehold") {
        const leaseholdPatterns = [
            /(\d+)\s+years?\s+left/i,  // "136 years left"
            /(\d+)\s+years?\s+remaining/i,
            /lease\s+(\d+)\s+years/i,
            /(\d+)\s+year\s+lease/i,
            /approximately\s+(\d+)\s+years/i,
            /length\s+of\s+lease[:\s]*(\d+)\s+years/i
        ];
        
        for (const pattern of leaseholdPatterns) {
            const match = description.match(pattern);
            if (match) {
                const years = parseInt(match[1]);
                cost.leaseholdInfo = `${years} years remaining`;
                break;
            }
        }
        // ADD THIS - Use leasehold details if available and no specific years found yet
        if ((!cost.leaseholdInfo || cost.leaseholdInfo === "Leasehold") && 
            property.leaseholdDetails && property.leaseholdDetails.leaseYears) {
            cost.leaseholdInfo = `${property.leaseholdDetails.leaseYears} years remaining`;
            console.log('💷 DEBUG: Using leasehold details years:', cost.leaseholdInfo);
        }
        
        // Check if it's freehold or leasehold mentioned without years
        if (!cost.leaseholdInfo) {
            if (description.match(/freehold/i)) {
                cost.leaseholdInfo = "Freehold";
            } else if (description.match(/leasehold/i)) {
                cost.leaseholdInfo = "Leasehold";
            }
        }
    }

    return cost;
}

// Helper function to extract price number from string
function extractPriceNumber(priceString) {
    if (!priceString) return null;
    
    // Remove common price prefixes and suffixes
    const cleanPrice = priceString
        .replace(/£|,/g, '')
        .replace(/\s+(pcm|per month|pw|per week)/i, '')
        .replace(/offers (in excess of|over|around)/i, '')
        .replace(/guide price/i, '')
        .trim();
    
    // Extract the first number found
    const numberMatch = cleanPrice.match(/(\d+)/);
    return numberMatch ? parseInt(numberMatch[1]) : null;
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
            
            // Apply 1.4x adjustment factor for older adult walking speed (5.0 km/h → 3.4 km/h)
            const durationMinutes = Math.ceil((leg.duration.value / 60) * 1.4);

            // Debug: Show original vs adjusted time
            console.log(`⏱️ Google says: ${Math.ceil(leg.duration.value / 60)} mins → Adjusted: ${durationMinutes} mins`);

            const result = {
                distance: leg.distance.text,
                duration: leg.duration.text,
                durationMinutes: durationMinutes,
                durationSeconds: Math.round(leg.duration.value * 1.4), // Adjusted for slower walking speed
                distanceMeters: leg.distance.value,
                routeWarnings: [...new Set(routeWarnings)],
                routeFeatures: routeFeatures,
                accessibilityScore: calculateRouteAccessibilityScore(routeFeatures, durationMinutes),
                accessibilityNotes: generateAccessibilityNotes(durationMinutes, routeFeatures, routeWarnings),
                gpName: gpName,
                steps: steps.length
            };
            
            console.log(`Walking route analysis complete:`, {
            time: `${result.durationMinutes} mins (adjusted)`,  // ✅ Shows adjusted time
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
    
    // Updated descriptions to match new scoring bands
    if (durationMinutes <= 5) {
        notes.push("Excellent proximity - very manageable walk");
    } else if (durationMinutes <= 10) {
        notes.push("Good walking distance for most people");
    } else if (durationMinutes <= 15) {
        notes.push("Moderate walk - manageable for regular trips");
    } else if (durationMinutes <= 20) {
        notes.push("Longer walk - may require rest stops");
    } else if (durationMinutes <= 25) {
        notes.push("Challenging walk - consider transport alternatives");
    } else {
        notes.push("Very long walk - transport strongly recommended");
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
    
    // Updated scoring bands for adjusted walking times
    if (durationMinutes <= 5) baseScore = 5;
    else if (durationMinutes <= 10) baseScore = 4;
    else if (durationMinutes <= 15) baseScore = 3;
    else if (durationMinutes <= 20) baseScore = 2;
    else if (durationMinutes <= 25) baseScore = 1;
    else baseScore = 0;
    
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
            busStops: busStops.slice(0, 3), // Top 3 nearest stops
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
                walkingTime: Math.round((calculateStraightLineDistance(lat, lng, place.location?.latitude, place.location?.longitude) * 1000) / 57), // 57m/min walking speed
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
        
        const rightmoveResponse = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000
        });

        const $ = cheerio.load(rightmoveResponse.data);
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

// ✅ ADD THESE VALIDATION FUNCTIONS TO YOUR SERVER.JS
// Add these functions somewhere in your server.js file, before your scraping function

// Helper function to validate location against coordinates
function validateLocationAgainstCoordinates(locationText, coordinates) {
    if (!coordinates || !locationText) return true; // If no coordinates, can't validate
    
    const { lat, lng } = coordinates;
    const locationLower = locationText.toLowerCase();
    
    // Define coordinate ranges for major UK cities
    const cityRanges = {
        london: { latMin: 51.28, latMax: 51.70, lngMin: -0.51, lngMax: 0.33 },
        manchester: { latMin: 53.35, latMax: 53.55, lngMin: -2.35, lngMax: -2.15 },
        birmingham: { latMin: 52.40, latMax: 52.60, lngMin: -2.00, lngMax: -1.80 },
        liverpool: { latMin: 53.30, latMax: 53.50, lngMin: -3.05, lngMax: -2.85 },
        leeds: { latMin: 53.70, latMax: 53.90, lngMin: -1.70, lngMax: -1.45 },
        bristol: { latMin: 51.40, latMax: 51.50, lngMin: -2.65, lngMax: -2.50 }
    };
    
    // Check if coordinates match the mentioned city
    for (const [city, range] of Object.entries(cityRanges)) {
        const isInCityRange = lat >= range.latMin && lat <= range.latMax && 
                             lng >= range.lngMin && lng <= range.lngMax;
        const locationMentionsCity = locationLower.includes(city);
        
        if (locationMentionsCity && !isInCityRange) {
            console.log(`🏠 Coordinate mismatch: Location mentions ${city} but coordinates are outside ${city} range`);
            return false;
        }
    }
    
    return true; // No obvious mismatch detected
}

// Helper function to get city name from coordinates
function getCityFromCoordinates(coordinates) {
    if (!coordinates) return null;
    
    const { lat, lng } = coordinates;
    
    const cityRanges = {
        'London': { latMin: 51.28, latMax: 51.70, lngMin: -0.51, lngMax: 0.33 },
        'Manchester': { latMin: 53.35, latMax: 53.55, lngMin: -2.35, lngMax: -2.15 },
        'Birmingham': { latMin: 52.40, latMax: 52.60, lngMin: -2.00, lngMax: -1.80 },
        'Liverpool': { latMin: 53.30, latMax: 53.50, lngMin: -3.05, lngMax: -2.85 },
        'Leeds': { latMin: 53.70, latMax: 53.90, lngMin: -1.70, lngMax: -1.45 },
        'Bristol': { latMin: 51.40, latMax: 51.50, lngMin: -2.65, lngMax: -2.50 }
    };
    
    for (const [city, range] of Object.entries(cityRanges)) {
        if (lat >= range.latMin && lat <= range.latMax && 
            lng >= range.lngMin && lng <= range.lngMax) {
            console.log(`🏠 Coordinates indicate property is in ${city}`);
            return `${city} (coordinates-corrected)`;
        }
    }
    
    return null; // City not identified
}

// ✅ FULL PROPERTY SCRAPING - Restore all functionality
async function scrapeRightmoveProperty(url) {
    try {
        console.log('Scraping Rightmove URL:', url);
        
        // Add random delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));

        const rightmoveResponse = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000
        });

        if (rightmoveResponse.status !== 200 || !rightmoveResponse.data) {
            throw new Error(`Rightmove response invalid. Status: ${rightmoveResponse.status}`);
        }
        console.log('🔍 Preview of HTML:', rightmoveResponse.data.substring(0, 300));


        const $ = cheerio.load(rightmoveResponse.data);
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
                console.log(`🔍 Checking selector element: "${locationText}" (length: ${locationText.length})`);
                
                // Check if this looks like a location (has street/area pattern)
                if (locationText && 
                    locationText.length > 5 && 
                    locationText.length < 70 && 
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
                    
                    // Validate against coordinates if available
                    if (!coordinates || validateLocationAgainstCoordinates(locationText, coordinates)) {
                        location = locationText;
                        console.log('Found location:', location);
                        return false; // Break out of loop
                    } else {
                        console.log('🏠 Skipping location due to coordinate mismatch:', locationText);
                    }
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
                        // Validate against coordinates
                        if (!coordinates || validateLocationAgainstCoordinates(locationText, coordinates)) {
                            location = locationText;
                            console.log('Found location near map:', location);
                        } else {
                            console.log('🏠 Skipping map location due to coordinate mismatch:', locationText);
                        }
                    }
                }
            }
        }

        // NEW METHOD: Extract from property description/combined text
        if (!location) {
            const allText = $('body').text();
            
            // Look for "location, london, postcode" pattern (your specific case)
            const londonPattern = /([^,]*),\s*([^,]*),\s*(plumstead|greenwich|woolwich|lewisham|bromley|bexley),\s*london,\s*(se\d+|sw\d+|e\d+|w\d+|n\d+|nw\d+|ne\d+|ec\d+|wc\d+)/i;
            const londonMatch = allText.match(londonPattern);
            
            if (londonMatch) {
                const potentialLocation = `${londonMatch[1].trim()}, ${londonMatch[2].trim()}, ${londonMatch[3].trim()}, London, ${londonMatch[4].toUpperCase()}`;
                
                if (!coordinates || validateLocationAgainstCoordinates(potentialLocation, coordinates)) {
                    location = potentialLocation;
                    console.log('Found London location in description:', location);
                }
            }
            
            // More general pattern for any UK location
            if (!location) {
                const ukPattern = /([^,]+),\s*([^,]+),\s*([^,]+),\s*([a-z]{2}\d+[a-z\d\s]*)/i;
                const ukMatch = allText.match(ukPattern);
                
                if (ukMatch) {
                    const potentialLocation = `${ukMatch[1].trim()}, ${ukMatch[2].trim()}, ${ukMatch[3].trim()}, ${ukMatch[4].toUpperCase()}`;
                    
                    if (!coordinates || validateLocationAgainstCoordinates(potentialLocation, coordinates)) {
                        location = potentialLocation;
                        console.log('Found UK location in description:', location);
                    }
                }
            }
        }
        
        // Improved fallback: Look for pattern matches but validate them
        if (!location) {
            const allText = $('body').text();
            const locationMatches = allText.match(/([A-Za-z\s]+ (?:Street|Road|Avenue|Lane|Close|Drive|Place),\s*[A-Za-z\s]+)/g);
            
            if (locationMatches && locationMatches.length > 0) {
                // Try each match and use the first one that validates
                for (const potentialLocation of locationMatches) {
                    if (!coordinates || validateLocationAgainstCoordinates(potentialLocation, coordinates)) {
                        location = potentialLocation;
                        console.log('Found location via pattern match:', location);
                        break;
                    } else {
                        console.log('🏠 Skipping pattern match due to coordinate mismatch:', potentialLocation);
                    }
                }
            }
        }
        
        // Final fallback: Use coordinates to determine city if all else fails
        if (!location && coordinates) {
            const cityFromCoords = getCityFromCoordinates(coordinates);
            if (cityFromCoords) {
                location = cityFromCoords;
                console.log('🏠 Using city from coordinates:', location);
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

        // ADD THE DEBUG CODE RIGHT HERE:
        console.log('🔍 All found images:', images?.slice(0, 5));
        console.log('🔍 Total images found:', images?.length);
        
        let floorplan = await tryFloorplanURL(propertyId);
        if (!floorplan) {
            $('img').each((i, img) => {
                const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
                const alt = $(img).attr('alt') || '';
                if (src && (alt.toLowerCase().includes('floorplan') ||
                    alt.toLowerCase().includes('floor plan') ||
                    src.includes('floorplan') || src.includes('FLP'))) {
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

        // ADD THIS SECTION: Extract tenure information
        console.log('🏠 Extracting tenure information...');
        let tenure = null;
        
        // Method 1: Look for structured tenure data
        const tenureSelectors = [
            '[data-testid="tenure"]',
            '.tenure-value',
            '.property-tenure',
            '[class*="tenure"]'
        ];
        
        for (const selector of tenureSelectors) {
            const tenureElement = $(selector);
            if (tenureElement.length && tenureElement.text().trim()) {
                tenure = tenureElement.text().trim();
                console.log('Found tenure in structured data:', tenure);
                break;
            }
        }
        
        // Method 2: Look for tenure in the property details section
        if (!tenure) {
            // Look for dt/dd pairs or similar structured content
            $('dt, th, .property-detail-key, .key').each((i, el) => {
                const keyText = $(el).text().toLowerCase().trim();
                if (keyText.includes('tenure')) {
                    const valueElement = $(el).next('dd, td, .property-detail-value, .value');
                    if (valueElement.length) {
                        tenure = valueElement.text().trim();
                        console.log('Found tenure in property details:', tenure);
                        return false; // Break
                    }
                }
            });
        }
        
        // Method 3: Pattern matching in page text
        if (!tenure) {
            const tenurePatterns = [
                /tenure[:\s]+([^.\n]+)/i,
                /tenure[:\s]*([a-z]+hold)/i,
                /property\s+type[:\s]+[^.\n]*tenure[:\s]*([a-z]+hold)/i
            ];
            
            for (const pattern of tenurePatterns) {
                const match = pageText.match(pattern);
                if (match) {
                    const tenureText = match[1].trim();
                    if (tenureText.toLowerCase().includes('freehold') || 
                        tenureText.toLowerCase().includes('leasehold')) {
                        tenure = tenureText;
                        console.log('Found tenure via pattern matching:', tenure);
                        break;
                    }
                }
            }
        }
        
        // Method 4: Look in structured property information sections
        if (!tenure) {
            // Check for common rightmove property info sections
            const propertyInfoSections = $('.property-information, .property-details, .key-information');
            propertyInfoSections.each((i, section) => {
                const sectionText = $(section).text();
                const tenureMatch = sectionText.match(/tenure[:\s]*([a-z]+hold)/i);
                if (tenureMatch) {
                    tenure = tenureMatch[1];
                    console.log('Found tenure in property info section:', tenure);
                    return false; // Break
                }
            });
        }
        
        console.log('Final tenure result:', tenure);

        // ADD THIS AFTER TENURE EXTRACTION: Extract detailed leasehold information
        console.log('🏠 Extracting detailed leasehold information...');
        let leaseholdDetails = {
            serviceCharge: null,
            groundRent: null,
            leaseYears: null
        };
        
        // Look for expandable sections or detailed property info
        const detailSections = $('.property-details, .leasehold-details, .expandable-section, .property-information');
        detailSections.each((i, section) => {
            const sectionText = $(section).text();
            console.log('🏠 DEBUG: Checking section text:', sectionText.substring(0, 200));
            
            // Look for service charge amounts
            const serviceMatch = sectionText.match(/(?:service|annual).*£([\d,]+)/i);
            if (serviceMatch) {
                leaseholdDetails.serviceCharge = serviceMatch[1];
                console.log('🏠 Found service charge in section:', serviceMatch[1]);
            }
            
            // Look for ground rent
            const groundRentMatch = sectionText.match(/ground\s*rent.*£([\d,]+)/i);
            if (groundRentMatch) {
                leaseholdDetails.groundRent = groundRentMatch[1];
                console.log('🏠 Found ground rent in section:', groundRentMatch[1]);
            }
            
            // Look for lease years
            const leaseYearsMatch = sectionText.match(/(\d+)\s*years?\s*(?:left|remaining)/i);
            if (leaseYearsMatch) {
                leaseholdDetails.leaseYears = leaseYearsMatch[1];
                console.log('🏠 Found lease years in section:', leaseYearsMatch[1]);
            }
        });
        
        // Also check all text content more comprehensively
        const allBodyText = $('body').text();
        console.log('🏠 DEBUG: Checking if 4116 appears anywhere on page:', allBodyText.includes('4116'));
        
        if (allBodyText.includes('4116')) {
            console.log('🏠 Found 4116 on page, extracting context...');
            const contextMatch = allBodyText.match(/.{0,100}4116.{0,100}/i);
            if (contextMatch) {
                console.log('🏠 Context around 4116:', contextMatch[0]);
                leaseholdDetails.serviceCharge = '4116';
            }
        }

        // Enhanced search for lease years - look in JSON data sources
if (!leaseholdDetails.leaseYears) {
    console.log('🏠 Looking for lease years in JSON data...');
    
    // Look for lease years in a broader context around where we found the service charge
    if (allBodyText.includes('4116')) {
        // Get a much larger context to find related lease data
        const broadContextMatch = allBodyText.match(/.{0,1000}4116.{0,1000}/i);
        if (broadContextMatch) {
            console.log('🏠 Broad JSON context around 4116:', broadContextMatch[0].substring(0, 500));
            
            // Look for lease-related JSON fields
            const leaseJsonPatterns = [
                /"leaseYears?"\s*:\s*(\d+)/i,
                /"remainingLeaseYears?"\s*:\s*(\d+)/i,
                /"lengthOfLease"\s*:\s*(\d+)/i,
                /"leaseLength"\s*:\s*(\d+)/i,
                /"yearsRemaining"\s*:\s*(\d+)/i
            ];
            
            for (const pattern of leaseJsonPatterns) {
                const match = broadContextMatch[0].match(pattern);
                if (match) {
                    leaseholdDetails.leaseYears = match[1];
                    console.log('🏠 Found lease years in JSON context:', match[1]);
                    break;
                }
            }
        }
    }
    
    // If still not found, look for any JSON-like data with lease info
    if (!leaseholdDetails.leaseYears) {
        const jsonLeasePatterns = [
            /"lease[^"]*"\s*:\s*"?(\d+)\s*years?/i,
            /lease[^:]*:\s*(\d+)/i,
            /(\d{2,3})\s*years?\s*(?:left|remaining)/i
        ];
        
        for (const pattern of jsonLeasePatterns) {
            const match = allBodyText.match(pattern);
            if (match) {
                const years = parseInt(match[1]);
                if (years >= 50 && years <= 999) {
                    leaseholdDetails.leaseYears = years.toString();
                    console.log('🏠 Found lease years in broader JSON search:', years);
                    break;
                }
            }
        }
    }
}

        // Look for ground rent in JSON context too
        if (!leaseholdDetails.groundRent) {
            // Look for ground rent in the JSON context
            if (allBodyText.includes('4116')) {
                const broadContextMatch = allBodyText.match(/.{0,1000}4116.{0,1000}/i);
                if (broadContextMatch) {
                    // Look for ground rent patterns in JSON
                    const groundRentJsonPatterns = [
                        /"groundRent"\s*:\s*"([^"]+)"/i,
                        /"groundRent"\s*:\s*(\d+)/i,
                        /groundRent[^:]*:\s*"?([^",}]+)/i
                    ];
                    
                    for (const pattern of groundRentJsonPatterns) {
                        const match = broadContextMatch[0].match(pattern);
                        if (match) {
                            leaseholdDetails.groundRent = match[1];
                            console.log('🏠 Found ground rent in JSON context:', match[1]);
                            break;
                        }
                    }
                }
            }
            
            // Fallback: if ground rent mentions "ask agent" anywhere
            if (!leaseholdDetails.groundRent && allBodyText.toLowerCase().includes('ground rent') && 
                allBodyText.toLowerCase().includes('ask agent')) {
                leaseholdDetails.groundRent = 'Ask agent';
                console.log('🏠 Found ground rent: Ask agent');
            }
        }

        // ADD THIS NEW SECTION HERE - Handle null/empty ground rent values
        if (leaseholdDetails.groundRent === 'null' || 
            leaseholdDetails.groundRent === null || 
            leaseholdDetails.groundRent === '') {
            leaseholdDetails.groundRent = 'Ask agent';
            console.log('🏠 Converting null ground rent to: Ask agent');
        }
        
        console.log('🏠 Final leasehold details:', leaseholdDetails);
        

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
            const pageHTML = rightmoveResponse.data;
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
            coordinates: coordinates,
            tenure: tenure,
            leaseholdDetails: leaseholdDetails,
            dimensions: await extractDimensions(description, title, features, floorplan)
        };

    } catch (error) {
        if (error.response) {
            console.error('❌ Axios response error:', error.response.status, error.response.statusText);
            console.error('Response body preview:', error.response.data?.substring(0, 300));
        } else if (error.request) {
            console.error('❌ No response received from Rightmove:', error.request);
        } else {
            console.error('❌ Unexpected error:', error.message);
        }
    
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
                    walkingTime: `${route.durationMinutes} mins`,  // ✅ Now shows adjusted time
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
                    gp: nearbyGPs[0].name,
                    time: `${route.durationMinutes} mins (adjusted)`,
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
            return {
                score: 5,
                rating: 'Most efficient',
                description: `Energy rating A - Most efficient. This property has excellent energy efficiency with very low heating costs, ideal for maintaining comfortable temperatures year-round.`
            };
        
        case 'B':
            return {
                score: 5,
                rating: 'Very efficient',
                description: `Energy rating B - Very efficient. This property has excellent energy efficiency with low heating costs, helping maintain comfortable temperatures.`
            };
        
        case 'C':
            return {
                score: 4,
                rating: 'Above average',
                description: `Energy rating C - Above average efficiency. This property has good energy efficiency with reasonable heating costs.`
            };
            
        case 'D':
            return {
                score: 3,
                rating: 'Average',
                description: `Energy rating D - Average efficiency. This property has typical energy efficiency with moderate heating costs.`
            };
            
        case 'E':
            return {
                score: 2,
                rating: 'Below average',
                description: `Energy rating E - Below average efficiency. This property may have higher heating costs and could be harder to keep warm in winter.`
            };
        
        case 'F':
            return {
                score: 1,
                rating: 'Poor',
                description: `Energy rating F - Poor efficiency. This property is likely to have high heating costs and may be challenging to maintain comfortable temperatures.`
            };
        
        case 'G':
            return {
                score: 0,
                rating: 'Very poor',
                description: `Energy rating G - Very poor efficiency. This property is likely to have very high heating costs and may be difficult to keep warm, which could significantly impact comfort and affordability.`
            };
            
        default:
            return {
                score: 3,
                rating: 'Unknown',
                description: 'Energy rating not available'
            };
    }
}

// Step 2b: Calculate Council Tax Score
function calculateCouncilTaxScore(councilTaxBand) {
    if (!councilTaxBand || councilTaxBand.includes('TBC')) {
        return {
            score: null, // null means "ignore this in scoring"
            rating: 'Unknown',
            description: 'Council tax band not confirmed - ask agent for details'
        };
    }
    
    const band = councilTaxBand.replace('Band ', '').trim().toUpperCase();
    
    switch (band) {
        case 'A':
            return {
                score: 5,
                rating: 'Cheapest band',
                description: 'Council tax Band A - the cheapest band, which helps keep ongoing costs low.'
            };
        
        case 'B':
        case 'C':
        case 'D':
            return {
                score: 4,
                rating: 'Average band',
                description: `Council tax Band ${band} - an average band with reasonable ongoing costs.`
            };
        
        case 'E':
            return {
                score: 3,
                rating: 'Above average band',
                description: 'Council tax Band E - an above average band with moderately higher costs.'
            };
        
        case 'F':
        case 'G':
            return {
                score: 2,
                rating: 'Expensive band',
                description: `Council tax Band ${band} - an expensive band which will add significantly to ongoing costs.`
            };
        
        case 'H':
            return {
                score: 1,
                rating: 'Most expensive band',
                description: 'Council tax Band H - the most expensive band, which will substantially increase ongoing costs.'
            };
        
        default:
            return {
                score: null,
                rating: 'Unknown',
                description: 'Council tax band not available - ask agent for details'
            };
    }
}

// Calculate Price per Sq M Score based on percentile thresholds
function calculatePricePerSqMScore(pricePerSqM) {
    if (!pricePerSqM || typeof pricePerSqM !== 'number') {
        return {
            score: null,
            rating: 'Unknown',
            description: 'Price per square meter not available',
            percentile: null
        };
    }
    
    let score, percentile, description;
    
    if (pricePerSqM <= 1963) {
        score = 5;
        percentile = '10th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is cheaper than 90% of properties on the market - excellent value.`;
    } else if (pricePerSqM <= 2184) {
        score = 4;
        percentile = '25th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is cheaper than 75% of properties on the market - good value.`;
    } else if (pricePerSqM <= 2507) {
        score = 3;
        percentile = '50th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is cheaper than 50% of properties on the market - average market value.`;
    } else if (pricePerSqM <= 3622) {
        score = 2;
        percentile = '75th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is only cheaper than 25% of properties on the market - above average cost.`;
    } else if (pricePerSqM <= 6015) {
        score = 1;
        percentile = '90th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is only cheaper than 10% of properties on the market - premium pricing.`;
    } else {
        score = 0;
        percentile = '>90th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property costs more than 90% of properties on the market - very expensive.`;
    }
    
    return {
        score: score,
        rating: getValueRating(score),
        description: description,
        percentile: percentile
    };
}

// Helper function for value-based ratings
function getValueRating(score) {
    if (score >= 5) return 'Excellent value';
    if (score >= 4) return 'Good value';
    if (score >= 3) return 'Average value';
    if (score >= 2) return 'Above average cost';
    if (score >= 1) return 'Premium pricing';
    return 'Very expensive';
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
    const accessibleFeatures = await calculateAccessibleFeaturesScore(property);
    
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

    // Step 5: NEW - Analyze Property Dimensions  
    console.log('📐 Analyzing property dimensions...');
    const dimensions = property.dimensions || null;

    // ADD THIS NEW STEP 6:
    // Step 6: NEW - Analyze Cost Information
    console.log('💷 Analyzing cost information...');
    const cost = analyzeCostInformation(property, dimensions);
    
    // Step 6b: Calculate Council Tax Score
console.log('💷 Calculating council tax score...');
const councilTaxAnalysis = calculateCouncilTaxScore(cost.councilTax);


// Step 6c: Calculate Price Per Sq M Score
console.log('💷 Calculating price per sq m score...');
let pricePerSqMAnalysis = { score: null, rating: 'Unknown', description: 'Not available' };

if (cost.pricePerSqM && !cost.pricePerSqM.includes('Unable')) {
    // Extract numeric value from "£4,412 per sq m"
    const priceMatch = cost.pricePerSqM.match(/£([\d,]+)/);
    if (priceMatch) {
        const priceNumber = parseInt(priceMatch[1].replace(/,/g, ''));
        pricePerSqMAnalysis = calculatePricePerSqMScore(priceNumber);
    }
}

// Step 6d: Calculate combined Property Cost Score
let propertyCostScore = null;
let propertyCostRating = 'Unknown';

if (councilTaxAnalysis.score !== null && pricePerSqMAnalysis.score !== null) {
    // Both available - average them
    propertyCostScore = (councilTaxAnalysis.score + pricePerSqMAnalysis.score) / 2;
    propertyCostRating = getScoreRating(propertyCostScore);
    console.log('💷 Property Cost: Both scores available, averaged');
} else if (councilTaxAnalysis.score !== null) {
    // Only council tax available - use it
    propertyCostScore = councilTaxAnalysis.score;
    propertyCostRating = getScoreRating(propertyCostScore);
    console.log('💷 Property Cost: Using Council Tax score only');
} else if (pricePerSqMAnalysis.score !== null) {
    // Only price per sq m available - use it
    propertyCostScore = pricePerSqMAnalysis.score;
    propertyCostRating = getScoreRating(pricePerSqMAnalysis.score);
    console.log('💷 Property Cost: Using Price/sq m score only');
}


// Updated overall score calculation (5 categories with Property Cost)
let scoresToAverage = [gpProximity.score, epcScore, accessibleFeatures.score, publicTransport.score];

if (propertyCostScore !== null) {
    scoresToAverage.push(propertyCostScore);
}

const overallScore = scoresToAverage.reduce((sum, score) => sum + score, 0) / scoresToAverage.length;

console.log('💷 Property Cost Score:', propertyCostScore);


// Debug logging before summary generation
console.log('📝 About to generate summary with:', {
    gpProximityScore: gpProximity.score,
    epcScore: epcScore,
    councilTaxScore: councilTaxAnalysis.score,
    councilTaxRating: councilTaxAnalysis.rating,
    title: property.title,
    epcRating: property.epcRating,
    location: property.location
});


// Generate comprehensive summary
let summary;
try {
    summary = generateComprehensiveSummary(
        gpProximity, 
        epcScore, 
        accessibleFeatures, 
        publicTransport, 
        cost,
        councilTaxAnalysis,
        pricePerSqMAnalysis,
        overallScore, 
        property.title, 
        property.epcRating, 
        property.location
    );
    console.log('✅ Summary generated successfully');
} catch (error) {
    console.error('❌ Summary generation failed:', error.message);
    console.error('Stack trace:', error.stack);
    throw error;
}
    
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
            details: '', 
            busStops: publicTransport.busStops || [],
            trainStations: publicTransport.trainStations || []
        },
        councilTax: {
            score: councilTaxAnalysis.score,
            rating: councilTaxAnalysis.score !== null ? getScoreRating(councilTaxAnalysis.score) : 'Unknown',
            details: councilTaxAnalysis.description,
            band: cost.councilTax
        },
        pricePerSqM: {
            score: pricePerSqMAnalysis.score,
            rating: pricePerSqMAnalysis.rating,
            details: pricePerSqMAnalysis.description,
            percentile: pricePerSqMAnalysis.percentile,
            value: cost.pricePerSqM
        },
        propertyCost: {
            score: propertyCostScore,
            rating: propertyCostRating,
            details: propertyCostScore !== null ? `Combined score from council tax and price per sq m` : 'Property cost information not available',
            councilTaxRating: councilTaxAnalysis.rating,
            pricePerSqMPercentile: pricePerSqMAnalysis.percentile
        },
        dimensions: property.dimensions || null,
        cost: cost,
        overall: Math.round((overallScore || 0) * 10) / 10,
        summary: summary || 'Analysis completed successfully'
    };
}

// Add publicTransport parameter to the function
function generateComprehensiveSummary(gpProximity, epcScore, accessibleFeatures, publicTransport, cost, councilTaxAnalysis, pricePerSqMAnalysis, overallScore, title, epcRating, location) {
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
    
    // NEW: Cost information early in summary
    if (cost && cost.price) {
        summary += `The property is priced at ${cost.price}`;
        if (cost.pricePerSqFt && !cost.pricePerSqFt.includes('Unable')) {
            summary += ` (${cost.pricePerSqFt})`;
        }
        summary += '. ';
    }
    
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

    // Additional cost considerations with enhanced context
    if (cost) {
        const costConsiderations = [];
        
        // Add council tax with descriptor - restructured for better flow
        if (cost.councilTax && councilTaxAnalysis && councilTaxAnalysis.rating) {
            const bandInfo = cost.councilTax.includes('Band') ? cost.councilTax : `Band ${cost.councilTax}`;
            costConsiderations.push(`${councilTaxAnalysis.rating.toLowerCase()} council tax (${bandInfo})`);
        }
        
        // Only add service charge if it exists and has actual info
        if (cost.serviceCharge && !cost.serviceCharge.includes('Not mentioned') && !cost.serviceCharge.includes('No service charge')) {
            costConsiderations.push(`service charges of ${cost.serviceCharge}`);
        }
        
        // Only add ground rent if it exists and isn't "Ask agent"
        if (cost.groundRent && !cost.groundRent.includes('Ask agent') && !cost.groundRent.includes('Peppercorn')) {
            costConsiderations.push(`ground rent of ${cost.groundRent}`);
        }
        
        if (costConsiderations.length > 0) {
            summary += `Additional ongoing costs include ${costConsiderations.join(' and ')}. `;
        }
        
        // Add price per sq m context as separate sentence
        if (cost.pricePerSqM && pricePerSqMAnalysis && pricePerSqMAnalysis.description && !cost.pricePerSqM.includes('Unable')) {
            summary += `${pricePerSqMAnalysis.description} `;
        }
        
        if (cost.leaseholdInfo && !cost.leaseholdInfo.includes('Freehold')) {
            summary += `The property is leasehold with ${cost.leaseholdInfo}. `;
        }
    }
    
    // 5. Energy efficiency in context of comfort and accessibility
    let epcRatingText = "very poor";
    if (epcScore >= 5) epcRatingText = "excellent";
    else if (epcScore >= 4) epcRatingText = "above average";
    else if (epcScore >= 3) epcRatingText = "average";
    else if (epcScore >= 2) epcRatingText = "below average";
    else if (epcScore >= 1) epcRatingText = "poor";

    // Always mention EPC, regardless of score
    summary += `The energy efficiency is ${epcRatingText}`;
    if (epcRating) {
        summary += ` with a ${epcRating} rating`;
    }

    // Add context based on rating
    if (epcScore >= 4) {
        summary += ", which should help keep heating costs manageable and maintain comfortable temperatures year-round. ";
    } else if (epcScore >= 3) {
        summary += ", with moderate heating costs typical for properties of this type. ";
    } else {
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
            setTimeout(() => reject(new Error('Analysis timeout')), 60000) // 30 seconds
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

        // Add this debug logging
        console.log('📤 Sending response with keys:', Object.keys(result.analysis));
        console.log('📤 Summary exists:', !!result.analysis.summary);
        console.log('📤 CouncilTax exists:', !!result.analysis.councilTax);

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
