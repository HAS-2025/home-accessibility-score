// server.js - Node.js Backend for Home Accessibility Score
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

// Claude API configuration
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// Try to access dedicated floorplan page
async function tryFloorplanURL(propertyId) {
    try {
        const floorplanURL = `https://www.rightmove.co.uk/properties/${propertyId}#/floorplan?activePlan=1&channel=RES_BUY`;
        
        console.log('Trying floorplan URL:', floorplanURL);
        
        const response = await axios.get(floorplanURL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Look for floorplan images on this dedicated page
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
    // If we already have coordinates from scraping, use those
    if (existingCoords && existingCoords.lat && existingCoords.lng) {
        console.log('Using coordinates from property scraping:', existingCoords);
        return existingCoords;
    }
    
    // Fallback: Use Geocoding API to get coordinates from address
    if (address && address !== 'Address not found') {
        try {
            console.log('Using Geocoding API for address:', address);
            
            const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?` +
                `address=${encodeURIComponent(address)}&` +
                `region=uk&` +  // Bias results to UK
                `key=${process.env.GOOGLE_MAPS_API_KEY}`;
            
            const response = await axios.get(geocodeUrl);
            
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

// Find nearest GPs using Places API (New) - optimized for UK GP surgeries
async function findNearestGPs(lat, lng) {
    try {
        console.log(`Finding GP surgeries near ${lat}, ${lng} using Places API (New)`);
        
        // Primary search: Focus on "doctor" type with UK-specific terms
        const requestBody = {
            includedTypes: ["doctor"], // Most accurate for GP surgeries
            maxResultCount: 20,
            locationRestriction: {
                circle: {
                    center: {
                        latitude: lat,
                        longitude: lng
                    },
                    radius: 2000.0 // 2km radius
                }
            },
            rankPreference: "DISTANCE", // Sort by proximity
            languageCode: "en-GB", // UK English
            regionCode: "GB" // UK region
        };
        
        console.log('Places API (New) request:', JSON.stringify(requestBody, null, 2));
        
        const response = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.id,places.businessStatus,places.websiteUri'
                },
                timeout: 10000 // 10 second timeout
            }
        );
        
        console.log('Places API response received');
        console.log('Total places found:', response.data.places?.length || 0);
        
        if (response.data.places && response.data.places.length > 0) {
            // Enhanced filtering for UK GP surgeries
            const gps = response.data.places
                .filter(place => {
                    const name = place.displayName?.text?.toLowerCase() || '';
                    const types = place.types || [];
                    const businessStatus = place.businessStatus;
                    
                    // Skip permanently closed places
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        console.log(`Skipping closed place: ${name}`);
                        return false;
                    }
                    
                    // UK-specific GP surgery indicators
                    const isGPSurgery = (
                        // UK-specific terms
                        name.includes('surgery') ||
                        name.includes('medical centre') ||
                        name.includes('medical center') ||
                        name.includes('health centre') ||
                        name.includes('health center') ||
                        name.includes('gp practice') ||
                        name.includes('doctors surgery') ||
                        name.includes('family practice') ||
                        name.includes('primary care') ||
                        
                        // General medical terms
                        name.includes('doctors') ||
                        name.includes('clinic') ||
                        name.includes('medical practice') ||
                        
                        // Type-based (most reliable)
                        types.includes('doctor') ||
                        types.includes('health')
                    );
                    
                    // Exclude non-GP medical facilities
                    const isExcluded = (
                        name.includes('hospital') ||
                        name.includes('pharmacy') ||
                        name.includes('dentist') ||
                        name.includes('dental') ||
                        name.includes('optician') ||
                        name.includes('chiropractor') ||
                        name.includes('physiotherapy') ||
                        name.includes('physio') ||
                        name.includes('vet') ||
                        name.includes('veterinary') ||
                        name.includes('care home') ||
                        name.includes('nursing home') ||
                        name.includes('mental health')
                    );
                    
                    const isValid = isGPSurgery && !isExcluded;
                    console.log(`${name}: GP=${isGPSurgery}, Excluded=${isExcluded}, Valid=${isValid}`);
                    
                    return isValid;
                })
                .map(place => ({
                    name: place.displayName?.text || 'Medical Practice',
                    address: place.formattedAddress || 'Address not available',
                    location: {
                        lat: place.location?.latitude,
                        lng: place.location?.longitude
                    },
                    rating: place.rating || null,
                    placeId: place.id,
                    businessStatus: place.businessStatus,
                    website: place.websiteUri || null
                }))
                .slice(0, 5); // Top 5 closest
            
            console.log(`Found ${gps.length} valid GP surgeries`);
            
            // If strict search finds GPs, return them
            if (gps.length > 0) {
                return gps;
            }
        }
        
        // Fallback: Broader search if no results
        console.log('No GPs found with strict search, trying broader criteria...');
        return await findGPsBroadSearch(lat, lng);
        
    } catch (error) {
        console.error('Places API (New) error:', error.response?.data || error.message);
        
        // Ultimate fallback: Legacy Places API
        console.log('Falling back to legacy Places API...');
        return await findGPsLegacyAPI(lat, lng);
    }
}

// Broader search using multiple place types
async function findGPsBroadSearch(lat, lng) {
    try {
        const requestBody = {
            includedTypes: ["doctor", "health", "hospital"], // Broader search
            maxResultCount: 30,
            locationRestriction: {
                circle: {
                    center: { latitude: lat, longitude: lng },
                    radius: 3000.0 // Wider radius
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
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.id'
                }
            }
        );
        
        if (response.data.places && response.data.places.length > 0) {
            const gps = response.data.places
                .filter(place => {
                    const name = place.displayName?.text?.toLowerCase() || '';
                    return (
                        (name.includes('surgery') || 
                         name.includes('medical') || 
                         name.includes('gp') || 
                         name.includes('doctors')) &&
                        !name.includes('hospital') && // Exclude large hospitals
                        !name.includes('pharmacy')    // Exclude pharmacies
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

// Legacy API fallback (still uses your enabled APIs)
async function findGPsLegacyAPI(lat, lng) {
    try {
        console.log('Using legacy Places API as final fallback...');
        
        const legacyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?` +
            `location=${lat},${lng}&` +
            `radius=2000&` +
            `type=doctor&` +
            `key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(legacyUrl);
        
        if (response.data.results && response.data.results.length > 0) {
            const gps = response.data.results
                .filter(place => {
                    const name = place.name.toLowerCase();
                    return (
                        name.includes('surgery') ||
                        name.includes('medical') ||
                        name.includes('gp') ||
                        name.includes('doctors')
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

// Analyze walking route using Directions API (precise walking calculations)
async function analyzeWalkingRoute(fromLat, fromLng, toLat, toLng, gpName) {
    try {
        console.log(`Calculating precise walking route to ${gpName} using Directions API`);
        
        // Using Directions API for accurate walking calculations
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${fromLat},${fromLng}&` +
            `destination=${toLat},${toLng}&` +
            `mode=walking&` +        // WALKING mode for pedestrian routes
            `units=metric&` +        // Metric units (km, minutes)
            `region=uk&` +           // UK-specific routing
            `language=en-GB&` +      // UK English
            `key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        console.log('Directions API request URL constructed');
        
        const response = await axios.get(directionsUrl, {
            timeout: 15000 // 15 second timeout for routing
        });
        
        if (response.data.routes && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            const leg = route.legs[0];
            
            console.log('Directions API returned route data:');
            console.log('- Distance:', leg.distance.text);
            console.log('- Duration:', leg.duration.text);
            console.log('- Steps:', leg.steps.length);
            
            // Analyze route for accessibility (stairs, hills, busy roads)
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
                
                // Detect accessibility challenges
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
                distance: leg.distance.text,         // e.g., "0.8 km"
                duration: leg.duration.text,         // e.g., "9 mins"
                durationMinutes: durationMinutes,    // e.g., 9
                durationSeconds: leg.duration.value, // e.g., 540
                distanceMeters: leg.distance.value,  // e.g., 800
                routeWarnings: [...new Set(routeWarnings)],
                routeFeatures: routeFeatures,
                accessibilityScore: calculateRouteAccessibilityScore(routeFeatures, durationMinutes),
                accessibilityNotes: generateAccessibilityNotes(durationMinutes, routeFeatures, routeWarnings),
                gpName: gpName,
                steps: steps.length // Number of route segments
            };
            
            console.log(`Walking route analysis complete:`, {
                time: result.duration,
                distance: result.distance,
                accessibility: result.accessibilityScore
            });
            
            return result;
        }
        
        console.log('Directions API: No walking route found');
        return null;
        
    } catch (error) {
        console.error('Directions API error:', error.response?.data || error.message);
        
        // If Directions API fails, try Routes API as fallback
        console.log('Trying Routes API as fallback...');
        return await analyzeWalkingRouteWithRoutesAPI(fromLat, fromLng, toLat, toLng, gpName);
    }
}

// Alternative using Routes API (if Directions API fails)
async function analyzeWalkingRouteWithRoutesAPI(fromLat, fromLng, toLat, toLng, gpName) {
    try {
        console.log(`Using Routes API for walking route to ${gpName}`);
        
        const requestBody = {
            origin: {
                location: {
                    latLng: {
                        latitude: fromLat,
                        longitude: fromLng
                    }
                }
            },
            destination: {
                location: {
                    latLng: {
                        latitude: toLat,
                        longitude: toLng
                    }
                }
            },
            travelMode: "WALK",
            routingPreference: "TRAFFIC_AWARE",
            computeAlternativeRoutes: false,
            languageCode: "en-GB",
            units: "METRIC"
        };
        
        const response = await axios.post(
            'https://routes.googleapis.com/directions/v2:computeRoutes',
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.legs'
                }
            }
        );
        
        if (response.data.routes && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            const leg = route.legs[0];
            
            const durationMinutes = Math.ceil(parseInt(route.duration.replace('s', '')) / 60);
            const distanceKm = (route.distanceMeters / 1000).toFixed(1);
            
            const result = {
                distance: `${distanceKm} km`,
                duration: `${durationMinutes} mins`,
                durationMinutes: durationMinutes,
                accessibilityScore: 4, // Default good score for Routes API
                accessibilityNotes: `${durationMinutes} minute walk to ${gpName}`,
                gpName: gpName
            };
            
            console.log(`Routes API result: ${result.duration} (${result.distance})`);
            return result;
        }
        
        return null;
    } catch (error) {
        console.error('Routes API error:', error.message);
        return null;
    }
}

// Calculate route accessibility score (1-5) based on real route analysis
function calculateRouteAccessibilityScore(features, durationMinutes) {
    let score = 5; // Start with perfect score
    
    // Deduct points for accessibility challenges
    if (features.hasStairs) score -= 2;
    if (features.hasSteepIncline) score -= 1.5;
    if (features.crossesBusyRoads && !features.hasTrafficLights) score -= 1;
    if (durationMinutes > 15) score -= 1;
    if (durationMinutes > 25) score -= 1;
    
    return Math.max(1, Math.round(score * 10) / 10); // Minimum score of 1
}

// Generate detailed accessibility notes
function generateAccessibilityNotes(durationMinutes, features, warnings) {
    const notes = [];
    
    // Duration assessment
    if (durationMinutes <= 5) {
        notes.push("Excellent proximity - very manageable walk");
    } else if (durationMinutes <= 10) {
        notes.push("Good walking distance for most people");
    } else if (durationMinutes <= 20) {
        notes.push("Moderate walk - may require rest stops");
    } else {
        notes.push("Long walk - consider transport alternatives");
    }
    
    // Accessibility features
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
    
    // Positive notes for good routes
    if (warnings.length === 0 && durationMinutes <= 10) {
        notes.push("Route appears level and pedestrian-friendly");
    }
    
    return notes.join('. ') + '.';
}

// Calculate final GP proximity score (1-5)
function calculateGPProximityScore(durationMinutes, routeAccessibilityScore = null) {
    let baseScore;
    
    // Base score from walking time (as per your requirements)
    if (durationMinutes <= 5) baseScore = 5;        // Excellent
    else if (durationMinutes <= 10) baseScore = 4;  // Very Good  
    else if (durationMinutes <= 20) baseScore = 3;  // Acceptable
    else if (durationMinutes <= 30) baseScore = 2;  // Challenging
    else baseScore = 1;                              // Poor
    
    // Adjust based on route accessibility if available
    if (routeAccessibilityScore !== null) {
        const adjustedScore = (baseScore + routeAccessibilityScore) / 2;
        return Math.round(adjustedScore * 10) / 10;
    }
    
    return baseScore;
}

// Scrape Rightmove property data
async function scrapeRightmoveProperty(url) {
    try {
        console.log('Scraping Rightmove URL:', url);
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Get all text content
        const pageText = $('body').text();
        
        // Extract property ID
        const propertyIdMatch = url.match(/properties\/(\d+)/);
        const propertyId = propertyIdMatch ? propertyIdMatch[1] : 'unknown';

        // Extract location coordinates from map data
let coordinates = null;
let address = '';

// Look for map-related data in the page
const scripts = $('script').toArray();
let mapData = null;

scripts.forEach(script => {
    const scriptContent = $(script).html() || '';
    
    // Look for latitude/longitude in various formats
    const latLngMatch = scriptContent.match(/(?:lat|latitude)["\s]*[:=]\s*([+-]?\d+\.?\d*)/i);
    const lngMatch = scriptContent.match(/(?:lng|longitude|long)["\s]*[:=]\s*([+-]?\d+\.?\d*)/i);
    
    if (latLngMatch && lngMatch) {
        coordinates = {
            lat: parseFloat(latLngMatch[1]),
            lng: parseFloat(lngMatch[1])
        };
        console.log('Found coordinates in script:', coordinates);
    }
    
    // Also look for address in map data
    const addressMatch = scriptContent.match(/(?:address|location)["\s]*[:=]\s*["']([^"']+)["']/i);
    if (addressMatch && !address) {
        address = addressMatch[1];
    }
});

// Alternative: look for data attributes on map elements
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

// Look for Google Maps or other map embed URLs
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

console.log('Extracted coordinates:', coordinates);
console.log('Extracted address:', address);
console.log('Extracted address:', address);
        
        // Extract title from page title tag
        const fullTitle = $('title').text();
        const titleMatch = fullTitle.match(/(.+?) for sale/i);
        const title = titleMatch ? titleMatch[1].trim() : fullTitle.split('open-rightmove')[0].trim();
        
        // Look for price patterns
        const priceMatch = pageText.match(/£[\d,]+/g);
        const price = priceMatch ? priceMatch[0] : 'Price not available';
        
        // Extract property description - try multiple approaches
        let description = '';
        
        // Try to find description sections
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
        
        // If no description found, try to extract from page text patterns
        if (!description) {
            const textSections = pageText.split('\n').filter(line => 
                line.length > 100 && 
                !line.includes('cookie') && 
                !line.includes('navigation') &&
                (line.includes('property') || line.includes('bedroom') || line.includes('kitchen'))
            );
            description = textSections[0] || 'No detailed description available';
        }
        
        // Extract images - look for property photos
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
        
        // Enhanced floorplan detection - try dedicated URL first
let floorplan = await tryFloorplanURL(propertyId);

if (!floorplan) {
    // Fallback to existing detection method
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

console.log('Final floorplan result:', !!floorplan);
        
        // Extract basic features
        const bedroomMatch = pageText.match(/(\d+)\s*bedroom/i);
        const bathroomMatch = pageText.match(/(\d+)\s*bathroom/i);
        
        const features = [];
        if (bedroomMatch) features.push(`${bedroomMatch[1]} bedroom${bedroomMatch[1] > 1 ? 's' : ''}`);
        if (bathroomMatch) features.push(`${bathroomMatch[1]} bathroom${bathroomMatch[1] > 1 ? 's' : ''}`);
        
        // Look for more features in description
        if (description.toLowerCase().includes('garage')) features.push('garage');
        if (description.toLowerCase().includes('garden')) features.push('garden');
        if (description.toLowerCase().includes('parking')) features.push('parking');
        if (description.toLowerCase().includes('ground floor')) features.push('ground floor accommodation');
        if (description.toLowerCase().includes('gas central heating')) features.push('gas central heating');
        if (description.toLowerCase().includes('double glazing')) features.push('double glazing');
        
        console.log('Extracted title:', title);
        console.log('Extracted price:', price);
        console.log('Description length:', description.length);
        console.log('Images found:', images.length);
        console.log('Floorplan found:', !!floorplan);
        console.log('Features:', features);
        
        return {
            id: propertyId,
            title: title,
            price: price,
            description: description,
            features: features,
            images: images.slice(0, 5), // Limit to first 5 images
            floorplan: floorplan,
            epcRating: null,
            address: address || 'Address not found',
            coordinates: coordinates
        };
        
    } catch (error) {
        console.error('Scraping error:', error.message);
        throw new Error('Failed to scrape property data');
    }
}

// Updated analyzePropertyAccessibility function with improved GP integration

async function analyzePropertyAccessibility(property) {
    console.log('Starting comprehensive property analysis...');
    
    // Step 1: Analyze GP proximity if coordinates are available
    let gpProximity = null;
    if (property.coordinates) {
        console.log('Analyzing GP proximity with enhanced search...');
        
        try {
            const nearbyGPs = await findNearestGPs(property.coordinates.lat, property.coordinates.lng);
            
            if (nearbyGPs.length > 0) {
                console.log(`Found ${nearbyGPs.length} GP surgeries nearby`);
                
                // Analyze route to the nearest GP
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
                    console.log('Could not calculate walking route to GP');
                    // Fallback: estimate based on straight-line distance
                    gpProximity = {
                        nearestGP: nearbyGPs[0].name,
                        address: nearbyGPs[0].address,
                        score: 3, // Default moderate score
                        accessibilityNotes: 'GP surgery found nearby, but walking route could not be calculated',
                        allNearbyGPs: nearbyGPs.slice(0, 3).map(gp => ({
                            name: gp.name,
                            address: gp.address
                        }))
                    };
                }
            } else {
                console.log('No GP surgeries found in the area');
                gpProximity = {
                    score: 1,
                    accessibilityNotes: 'No GP surgeries found within reasonable walking distance'
                };
            }
        } catch (error) {
            console.error('GP proximity analysis failed:', error.message);
            gpProximity = {
                score: 2, // Default below-average score if analysis fails
                accessibilityNotes: 'Unable to analyze GP proximity at this time'
            };
        }
    } else {
        console.log('No property coordinates available for GP analysis');
        gpProximity = {
            score: 2,
            accessibilityNotes: 'Property location coordinates not available for GP proximity analysis'
        };
    }

    // Step 2: Extract EPC rating from property data
    let epcScore = 3; // Default average score
    let epcDetails = 'EPC rating not specified';
    
    if (property.epcRating) {
        const rating = property.epcRating.toUpperCase();
        switch(rating) {
            case 'A':
            case 'B':
                epcScore = 5;
                epcDetails = `Excellent energy efficiency (${rating} rating) - low heating costs`;
                break;
            case 'C':
            case 'D':
                epcScore = 4;
                epcDetails = `Good energy efficiency (${rating} rating) - reasonable heating costs`;
                break;
            case 'E':
                epcScore = 3;
                epcDetails = `Average energy efficiency (${rating} rating) - moderate heating costs`;
                break;
            case 'F':
                epcScore = 2;
                epcDetails = `Poor energy efficiency (${rating} rating) - high heating costs`;
                break;
            case 'G':
                epcScore = 1;
                epcDetails = `Very poor energy efficiency (${rating} rating) - very high heating costs`;
                break;
        }
    } else {
        // Try to extract EPC from description or features
        const fullText = `${property.description} ${property.features.join(' ')}`.toLowerCase();
        if (fullText.includes('epc')) {
            const epcMatch = fullText.match(/epc[:\s]*([a-g])/i);
            if (epcMatch) {
                property.epcRating = epcMatch[1].toUpperCase();
                // Recursively call this section with the found rating
                const rating = property.epcRating;
                switch(rating) {
                    case 'A':
                    case 'B':
                        epcScore = 5;
                        epcDetails = `Excellent energy efficiency (${rating} rating) - low heating costs`;
                        break;
                    case 'C':
                    case 'D':
                        epcScore = 4;
                        epcDetails = `Good energy efficiency (${rating} rating) - reasonable heating costs`;
                        break;
                    case 'E':
                        epcScore = 3;
                        epcDetails = `Average energy efficiency (${rating} rating) - moderate heating costs`;
                        break;
                    case 'F':
                        epcScore = 2;
                        epcDetails = `Poor energy efficiency (${rating} rating) - high heating costs`;
                        break;
                    case 'G':
                        epcScore = 1;
                        epcDetails = `Very poor energy efficiency (${rating} rating) - very high heating costs`;
                        break;
                }
            }
        }
    }

    // Step 3: Analyze internal facilities
    const fullText = `${property.description} ${property.features.join(' ')}`.toLowerCase();
    let facilitiesScore = 0;
    const facilitiesFound = [];
    
    // Check for bedrooms (2 or more)
    const bedroomMatch = fullText.match(/(\d+)\s*bedroom/);
    if (bedroomMatch && parseInt(bedroomMatch[1]) >= 2) {
        facilitiesScore += 1;
        facilitiesFound.push(`${bedroomMatch[1]} bedrooms`);
    }
    
    // Check for kitchen
    if (fullText.includes('kitchen')) {
        facilitiesScore += 1;
        facilitiesFound.push('kitchen');
    }
    
    // Check for living room
    if (fullText.includes('living room') || fullText.includes('lounge') || fullText.includes('reception')) {
        facilitiesScore += 1;
        facilitiesFound.push('living room');
    }
    
    // Check for en suite
    if (fullText.includes('en suite') || fullText.includes('en-suite') || fullText.includes('ensuite')) {
        facilitiesScore += 1;
        facilitiesFound.push('en suite');
    }
    
    // Check for separate bathroom/toilet
    if (fullText.includes('bathroom') || fullText.includes('toilet') || fullText.includes('wc')) {
        facilitiesScore += 1;
        facilitiesFound.push('bathroom/toilet');
    }
    
    // Ensure facilitiesScore doesn't exceed 5
    facilitiesScore = Math.min(facilitiesScore, 5);
    
    const facilitiesDetails = facilitiesFound.length > 0 
        ? `Property includes: ${facilitiesFound.join(', ')}`
        : 'Limited facility information available';

    // Step 4: Calculate overall score
    const overallScore = (gpProximity.score + epcScore + facilitiesScore) / 3;
    
    // Step 5: Generate comprehensive summary
    const summary = generateComprehensiveSummary(gpProximity, epcScore, facilitiesScore, overallScore);
    
    console.log('Analysis complete:', {
        gpScore: gpProximity.score,
        epcScore: epcScore,
        facilitiesScore: facilitiesScore,
        overall: overallScore
    });

    return {
    gpProximity: {
        score: gpProximity.score || 0,
        rating: getScoreRating(gpProximity.score || 0),
        details: gpProximity.accessibilityNotes || 'No details available',
        nearestGP: gpProximity.nearestGP || null,
        walkingTime: gpProximity.walkingTime || null,
        distance: gpProximity.distance || null,
        warnings: gpProximity.warnings || [],
        allNearbyGPs: gpProximity.allNearbyGPs || []
    },
    epcRating: {
        score: epcScore || 0,
        rating: getScoreRating(epcScore || 0),
        details: epcDetails || 'No EPC details available',
        actualRating: property.epcRating || null
    },
    internalFacilities: {
        score: facilitiesScore || 0,
        rating: getScoreRating(facilitiesScore || 0),
        details: facilitiesDetails || 'No facilities details available',
        facilitiesFound: facilitiesFound || []
    },
    overall: Math.round((overallScore || 0) * 10) / 10,
    summary: summary || 'Analysis completed successfully'
};

// Generate comprehensive summary
function generateComprehensiveSummary(gpProximity, epcScore, facilitiesScore, overallScore) {
    const summaryParts = [];
    
    // Overall assessment
    if (overallScore >= 4) {
        summaryParts.push("This property shows excellent suitability for older adults");
    } else if (overallScore >= 3) {
        summaryParts.push("This property offers good accessibility features for older adults");
    } else if (overallScore >= 2) {
        summaryParts.push("This property has some accessibility considerations for older adults");
    } else {
        summaryParts.push("This property may present accessibility challenges for older adults");
    }
    
    // Key strengths
    const strengths = [];
    if (gpProximity.score >= 4) strengths.push("excellent GP proximity");
    if (epcScore >= 4) strengths.push("good energy efficiency");
    if (facilitiesScore >= 4) strengths.push("suitable room configuration");
    
    if (strengths.length > 0) {
        summaryParts.push(`with ${strengths.join(' and ')}`);
    }
    
    // Key concerns
    const concerns = [];
    if (gpProximity.score <= 2) concerns.push("limited GP access");
    if (epcScore <= 2) concerns.push("poor energy efficiency");
    if (facilitiesScore <= 2) concerns.push("limited facilities");
    
    if (concerns.length > 0) {
        summaryParts.push(`Main concerns include ${concerns.join(' and ')}`);
    }
    
    return summaryParts.join('. ') + '.';
}

// Helper function to convert score to rating text (if not already defined)
function getScoreRating(score) {
    if (score >= 4.5) return 'Excellent';
    if (score >= 3.5) return 'Good';
    if (score >= 2.5) return 'Fair';
    return 'Poor';
}

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// API Routes
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

        // Step 1: Get property data
        const property = await scrapeRightmoveProperty(url);
        console.log('Property data obtained:', property.title);

        // Step 2: Analyze with new 3-factor system
        const analysis = await analyzePropertyAccessibility(property);
        console.log('Analysis completed');

        const result = {
            property: {
                title: property.title,
                price: property.price,
                url: url
            },
            analysis: analysis,  // ✅ Now uses new 3-factor scoring
            timestamp: new Date().toISOString()
        };

        res.json(result);

    } catch (error) {
        console.error('Analysis error:', error.message);
        res.status(500).json({ 
            error: error.message || 'Failed to analyze property' 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🏠 Home Accessibility Score API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    
    if (!process.env.CLAUDE_API_KEY) {
        console.warn('⚠️  Warning: CLAUDE_API_KEY not set in environment variables');
    }
});

module.exports = app;
