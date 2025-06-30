// server.js - Ultra-fast deployment version
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

// 🚀 DEPLOYMENT OPTIMIZATION: Completely remove EPC Vision Extractor for now
// We can add it back as an optional feature after deployment succeeds

// Store for caching results
const cache = new Map();

// Short timeouts for fast deployment
const API_TIMEOUT = 6000;
const DIRECTIONS_TIMEOUT = 8000;

// Basic coordinate extraction
async function getPropertyCoordinates(address, existingCoords) {
    if (existingCoords && existingCoords.lat && existingCoords.lng) {
        return existingCoords;
    }
    
    if (address && address !== 'Address not found' && process.env.GOOGLE_MAPS_API_KEY) {
        try {
            const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?` +
                `address=${encodeURIComponent(address)}&region=uk&key=${process.env.GOOGLE_MAPS_API_KEY}`;
            
            const response = await axios.get(geocodeUrl, { timeout: API_TIMEOUT });
            
            if (response.data.results?.length > 0) {
                const location = response.data.results[0].geometry.location;
                return { lat: location.lat, lng: location.lng };
            }
        } catch (error) {
            console.error('Geocoding error:', error.message);
        }
    }
    
    return null;
}

// ✅ KEEP FULL GP FILTERING - This is crucial for accuracy
async function findNearestGPs(lat, lng) {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        return [];
    }

    try {
        const requestBody = {
            includedTypes: ["doctor"],
            maxResultCount: 15, // Reduced for speed
            locationRestriction: {
                circle: { center: { latitude: lat, longitude: lng }, radius: 2000.0 }
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
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.businessStatus'
                },
                timeout: API_TIMEOUT
            }
        );

        if (response.data.places?.length > 0) {
            // ✅ KEEP ENHANCED FILTERING - This prevents fertility clinics etc.
            const gps = response.data.places
                .filter(place => {
                    const name = place.displayName?.text?.toLowerCase() || '';
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') return false;
                    
                    // Strict exclusions
                    const isDefinitelyNotGP = (
                        name.includes('ear wax') || name.includes('earwax') || name.includes('chiropody') ||
                        name.includes('podiatry') || name.includes('foot care') || name.includes('hearing') ||
                        name.includes('fertility') || name.includes('acupuncture') || name.includes('chiropractor') ||
                        name.includes('physiotherapy') || name.includes('physio') || name.includes('osteopath') ||
                        name.includes('counselling') || name.includes('therapy') || name.includes('beauty') ||
                        name.includes('aesthetic') || name.includes('cosmetic') || name.includes('laser') ||
                        name.includes('massage') || name.includes('pharmacy') || name.includes('dentist') ||
                        name.includes('dental') || name.includes('optician') || name.includes('vet') ||
                        name.includes('veterinary') || name.includes('care home') || name.includes('hospital')
                    );
                    
                    if (isDefinitelyNotGP) return false;
                    
                    // Positive identification
                    const isLikelyGPSurgery = (
                        name.includes('gp surgery') || name.includes('doctors surgery') ||
                        name.includes('medical centre') || name.includes('medical center') ||
                        name.includes('health centre') || name.includes('health center') ||
                        name.includes('family practice') || name.includes('primary care') ||
                        name.includes('group practice') || name.includes('health practice') ||
                        (name.includes('surgery') && (name.includes('dr ') || name.includes('medical') || name.includes('health'))) ||
                        (name.includes('medical') && (name.includes('centre') || name.includes('center')) && !name.includes('specialist'))
                    );
                    
                    return isLikelyGPSurgery;
                })
                .map(place => ({
                    name: place.displayName?.text || 'Medical Practice',
                    address: place.formattedAddress || 'Address not available',
                    location: {
                        lat: place.location?.latitude,
                        lng: place.location?.longitude
                    }
                }))
                .slice(0, 3); // Top 3 only for speed
            
            return gps;
        }

        return [];
        
    } catch (error) {
        console.error('Places API error:', error.message);
        return [];
    }
}

// Simplified walking route analysis
async function analyzeWalkingRoute(fromLat, fromLng, toLat, toLng, gpName) {
    if (!process.env.GOOGLE_MAPS_API_KEY) return null;

    try {
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${fromLat},${fromLng}&destination=${toLat},${toLng}&mode=walking&units=metric&region=uk&` +
            `key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(directionsUrl, { timeout: DIRECTIONS_TIMEOUT });
        
        if (response.data.routes?.length > 0) {
            const leg = response.data.routes[0].legs[0];
            const durationMinutes = Math.ceil(leg.duration.value / 60);
            
            // Simplified route analysis
            const steps = leg.steps || [];
            const hasAccessibilityIssues = steps.some(step => {
                const instruction = step.html_instructions?.toLowerCase() || '';
                return instruction.includes('stairs') || instruction.includes('steep') || instruction.includes('hill');
            });
            
            const accessibilityScore = hasAccessibilityIssues ? 
                Math.max(1, 5 - Math.floor(durationMinutes / 10)) :
                Math.max(1, 5 - Math.floor(durationMinutes / 8));
            
            let accessibilityNotes = '';
            if (durationMinutes <= 5) accessibilityNotes = "Excellent proximity - very manageable walk";
            else if (durationMinutes <= 10) accessibilityNotes = "Good walking distance";
            else if (durationMinutes <= 20) accessibilityNotes = "Moderate walk - may require rest stops";
            else accessibilityNotes = "Long walk - consider transport alternatives";
            
            if (hasAccessibilityIssues) {
                accessibilityNotes += ". Route may include stairs or steep sections";
            }
            
            return {
                distance: leg.distance.text,
                duration: leg.duration.text,
                durationMinutes: durationMinutes,
                accessibilityScore: accessibilityScore,
                accessibilityNotes: accessibilityNotes,
                gpName: gpName,
                routeWarnings: hasAccessibilityIssues ? ['Potential accessibility challenges'] : []
            };
        }
        
        return null;
        
    } catch (error) {
        console.error('Directions API error:', error.message);
        return null;
    }
}

function calculateGPProximityScore(durationMinutes, routeAccessibilityScore = null) {
    let baseScore;
    if (durationMinutes <= 5) baseScore = 5;
    else if (durationMinutes <= 10) baseScore = 4;
    else if (durationMinutes <= 20) baseScore = 3;
    else if (durationMinutes <= 30) baseScore = 2;
    else baseScore = 1;
    
    if (routeAccessibilityScore !== null) {
        return Math.round(((baseScore + routeAccessibilityScore) / 2) * 10) / 10;
    }
    return baseScore;
}

// 🚀 FAST EPC EXTRACTION - Simple text patterns only for now
function extractSimpleEPC(description, pageText) {
    let epcData = {
        rating: null,
        confidence: 0,
        reason: 'Not found',
        numericalScore: 0
    };

    const epcPatterns = [
        /epc\s*rating[:\s]*([a-g])\b/gi,
        /energy\s*performance[:\s]*([a-g])\b/gi,
        /energy\s*rating[:\s]*([a-g])\b/gi,
        /energy\s*efficiency[:\s]*([a-g])\b/gi
    ];
    
    const searchText = `${description} ${pageText}`.toLowerCase();
    
    for (const pattern of epcPatterns) {
        const match = searchText.match(pattern);
        if (match) {
            const rating = match[1].toUpperCase();
            if (['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(rating)) {
                // Simple context validation
                const matchIndex = searchText.indexOf(match[0].toLowerCase());
                const context = searchText.substring(Math.max(0, matchIndex - 30), matchIndex + 30);
                
                const hasEnergyContext = context.includes('energy') || context.includes('epc');
                const isFinancialContext = context.includes('council tax') || context.includes('band:');
                
                if (hasEnergyContext && !isFinancialContext) {
                    epcData = {
                        rating: rating,
                        confidence: 70,
                        reason: `Text extraction: "${match[0]}"`,
                        numericalScore: 0
                    };
                    break;
                }
            }
        }
    }

    return epcData;
}

// Streamlined property scraping
async function scrapeRightmoveProperty(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: API_TIMEOUT
        });

        const $ = cheerio.load(response.data);
        const pageText = $('body').text();
        const propertyIdMatch = url.match(/properties\/(\d+)/);
        const propertyId = propertyIdMatch?.[1] || 'unknown';

        // Extract coordinates (simplified)
        let coordinates = null;
        const scripts = $('script').toArray().slice(0, 5); // Limit script checking
        
        for (const script of scripts) {
            const scriptContent = $(script).html() || '';
            const latMatch = scriptContent.match(/(?:lat|latitude)["\s]*[:=]\s*([+-]?\d+\.?\d*)/i);
            const lngMatch = scriptContent.match(/(?:lng|longitude)["\s]*[:=]\s*([+-]?\d+\.?\d*)/i);

            if (latMatch && lngMatch) {
                coordinates = {
                    lat: parseFloat(latMatch[1]),
                    lng: parseFloat(lngMatch[1])
                };
                break;
            }
        }

        // Extract basic info
        const fullTitle = $('title').text();
        const titleMatch = fullTitle.match(/(.+?) for sale/i);
        const title = titleMatch?.[1]?.trim() || fullTitle.split('open-rightmove')[0].trim();
        
        const priceMatch = pageText.match(/£[\d,]+/g);
        const price = priceMatch?.[0] || 'Price not available';

        // Get description (simplified)
        let description = '';
        const descSelectors = ['[data-testid="property-description"]', '.property-description', '[class*="description"]'];
        
        for (const selector of descSelectors) {
            const desc = $(selector).text().trim();
            if (desc?.length > 50) {
                description = desc;
                break;
            }
        }

        // Extract features
        const bedroomMatch = pageText.match(/(\d+)\s*bedroom/i);
        const bathroomMatch = pageText.match(/(\d+)\s*bathroom/i);
        const features = [];
        
        if (bedroomMatch) features.push(`${bedroomMatch[1]} bedroom${bedroomMatch[1] > 1 ? 's' : ''}`);
        if (bathroomMatch) features.push(`${bathroomMatch[1]} bathroom${bathroomMatch[1] > 1 ? 's' : ''}`);

        // Extract EPC (simple text only)
        const epcData = extractSimpleEPC(description, pageText);

        return {
            id: propertyId,
            title: title,
            price: price,
            description: description,
            features: features,
            address: 'Address extraction simplified',
            coordinates: coordinates,
            epc: epcData,
            epcRating: epcData.rating
        };
        
    } catch (error) {
        console.error('Scraping error:', error.message);
        throw new Error('Failed to scrape property data');
    }
}

// Streamlined accessibility analysis
async function analyzePropertyAccessibility(property) {
    // Step 1: GP proximity
    let gpProximity = { score: 2, accessibilityNotes: 'GP analysis unavailable' };
    
    if (property.coordinates) {
        try {
            const nearbyGPs = await findNearestGPs(property.coordinates.lat, property.coordinates.lng);
            
            if (nearbyGPs.length > 0) {
                const route = await analyzeWalkingRoute(
                    property.coordinates.lat, property.coordinates.lng,
                    nearbyGPs[0].location.lat, nearbyGPs[0].location.lng,
                    nearbyGPs[0].name
                );
                
                if (route) {
                    gpProximity = {
                        nearestGP: nearbyGPs[0].name,
                        address: nearbyGPs[0].address,
                        walkingTime: route.duration,
                        distance: route.distance,
                        score: calculateGPProximityScore(route.durationMinutes, route.accessibilityScore),
                        accessibilityNotes: route.accessibilityNotes,
                        warnings: route.routeWarnings
                    };
                } else {
                    gpProximity = {
                        nearestGP: nearbyGPs[0].name,
                        score: 3,
                        accessibilityNotes: 'GP surgery found nearby'
                    };
                }
            }
        } catch (error) {
            console.error('GP analysis error:', error.message);
        }
    }

    // Step 2: EPC Score
    let epcScore = 3;
    let epcDetails = 'EPC rating not specified';

    if (property.epc?.rating) {
        const letterScores = { 'A': 5, 'B': 4, 'C': 4, 'D': 3, 'E': 2, 'F': 2, 'G': 1 };
        epcScore = letterScores[property.epc.rating] || 3;
        epcDetails = `Energy rating ${property.epc.rating} (${property.epc.confidence}% confidence)`;
    }
    
    // Step 3: Facilities
    const fullText = `${property.description} ${property.features.join(' ')}`.toLowerCase();
    let facilitiesScore = 0;
    const facilitiesFound = [];
    
    if (fullText.includes('bedroom')) { facilitiesScore += 1; facilitiesFound.push('bedrooms'); }
    if (fullText.includes('kitchen')) { facilitiesScore += 1; facilitiesFound.push('kitchen'); }
    if (fullText.includes('living') || fullText.includes('lounge')) { facilitiesScore += 1; facilitiesFound.push('living area'); }
    if (fullText.includes('bathroom')) { facilitiesScore += 1; facilitiesFound.push('bathroom'); }
    
    facilitiesScore = Math.min(facilitiesScore, 5);
    const overallScore = (gpProximity.score + epcScore + facilitiesScore) / 3;

    return {
        gpProximity: {
            score: gpProximity.score,
            rating: getScoreRating(gpProximity.score),
            details: gpProximity.accessibilityNotes,
            nearestGP: gpProximity.nearestGP || null,
            walkingTime: gpProximity.walkingTime || null,
            warnings: gpProximity.warnings || []
        },
        epcRating: {
            score: epcScore,
            rating: getScoreRating(epcScore),
            details: epcDetails,
            actualRating: property.epc?.rating || null
        },
        internalFacilities: {
            score: facilitiesScore,
            rating: getScoreRating(facilitiesScore),
            details: facilitiesFound.length ? `Property includes: ${facilitiesFound.join(', ')}` : 'Basic facilities'
        },
        overall: Math.round(overallScore * 10) / 10,
        summary: `Property analysis completed with overall score of ${Math.round(overallScore * 10) / 10}/5`
    };
}

function getScoreRating(score) {
    if (score >= 4.5) return 'Excellent';
    if (score >= 3.5) return 'Good';
    if (score >= 2.5) return 'Fair';
    return 'Poor';
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: 'fast-deployment'
    });
});

app.post('/api/analyze', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url?.includes('rightmove.co.uk')) {
            return res.status(400).json({ error: 'Please provide a valid Rightmove property URL' });
        }

        // Overall timeout for entire request
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), 20000)
        );

        const analysisPromise = async () => {
            const property = await scrapeRightmoveProperty(url);
            const analysis = await analyzePropertyAccessibility(property);
            
            return {
                property: { title: property.title, price: property.price, url },
                analysis,
                timestamp: new Date().toISOString()
            };
        };

        const result = await Promise.race([analysisPromise(), timeoutPromise]);
        res.json(result);

    } catch (error) {
        console.error('Analysis error:', error.message);
        res.status(500).json({ error: error.message || 'Failed to analyze property' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FAST Server running on port ${PORT}`);
    console.log(`📊 Health: http://localhost:${PORT}/health`);
    console.log('⚡ Optimized for rapid deployment - Vision API disabled');
});

module.exports = app;
