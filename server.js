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

// Find nearest GP surgeries using NEW Google Places API
async function findNearestGPs(lat, lng) {
    try {
        console.log(`Finding real GPs near coordinates ${lat}, ${lng} using NEW API`);
        
        // Use NEW Places API - Nearby Search
        const requestBody = {
            includedTypes: ["doctor", "hospital", "medical_clinic"],
            maxResultCount: 10,
            locationRestriction: {
                circle: {
                    center: {
                        latitude: lat,
                        longitude: lng
                    },
                    radius: 3000.0
                }
            }
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
        
        console.log('NEW API Response received');
        
        if (response.data.places && response.data.places.length > 0) {
            console.log(`Found ${response.data.places.length} medical facilities`);
            
            // Filter for likely GP surgeries
            const gps = response.data.places.filter(place => {
                const name = place.displayName?.text?.toLowerCase() || '';
                const types = place.types || [];
                
                return (
                    name.includes('surgery') ||
                    name.includes('medical centre') ||
                    name.includes('medical center') ||
                    name.includes('health centre') ||
                    name.includes('gp') ||
                    name.includes('family practice') ||
                    name.includes('clinic') ||
                    name.includes('doctors') ||
                    types.includes('doctor')
                );
            }).map(place => ({
                name: place.displayName?.text || 'Medical Facility',
                address: place.formattedAddress || 'Address not available',
                location: {
                    lat: place.location?.latitude,
                    lng: place.location?.longitude
                },
                rating: place.rating || 'No rating',
                placeId: place.id
            }));
            
            console.log(`Filtered to ${gps.length} GP surgeries:`, gps.map(gp => gp.name));
            return gps.slice(0, 3);
        }
        
        console.log('No medical facilities found');
        return [];
        
    } catch (error) {
        console.error('Google Places NEW API error:', error.response?.data || error.message);
        return [];
    }
}
// Get walking directions and analyze route accessibility
async function analyzeWalkingRoute(fromLat, fromLng, toLat, toLng, gpName) {
    try {
        console.log(`Getting real walking route to ${gpName}`);
        
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${fromLat},${fromLng}&destination=${toLat},${toLng}&mode=walking&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(directionsUrl);
        
        if (response.data.routes && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            const leg = route.legs[0];
            
            // Analyze route for accessibility concerns
            const steps = leg.steps;
            const routeWarnings = [];
            
            steps.forEach(step => {
                const instruction = step.html_instructions.toLowerCase();
                
                // Look for potential accessibility issues
                if (instruction.includes('stairs') || instruction.includes('steps')) {
                    routeWarnings.push('Route includes stairs or steps');
                }
                if (instruction.includes('steep') || instruction.includes('hill')) {
                    routeWarnings.push('Route includes steep incline');
                }
                if (instruction.includes('busy') || instruction.includes('main road')) {
                    routeWarnings.push('Route crosses busy roads');
                }
            });
            
            const result = {
                distance: leg.distance.text,
                duration: leg.duration.text,
                durationMinutes: Math.ceil(leg.duration.value / 60),
                routeWarnings: [...new Set(routeWarnings)], // Remove duplicates
                accessibilityNotes: generateAccessibilityNotes(leg, routeWarnings),
                gpName: gpName
            };
            
            console.log(`Real route analysis: ${result.duration} (${result.distance})`);
            return result;
        }
        
        console.log('No walking route found');
        return null;
    } catch (error) {
        console.error('Google Directions API error:', error.response?.data || error.message);
        return null;
    }
}

// Generate accessibility-focused route analysis
function generateAccessibilityNotes(leg, warnings) {
    const duration = Math.ceil(leg.duration.value / 60);
    let notes = [];
    
    if (duration <= 5) {
        notes.push("Excellent proximity - very manageable walk for most older adults");
    } else if (duration <= 10) {
        notes.push("Good proximity - comfortable walking distance");
    } else if (duration <= 20) {
        notes.push("Moderate distance - may require planning for longer walk");
    } else {
        notes.push("Longer walk - consider transport alternatives");
    }
    
    if (warnings.length === 0) {
        notes.push("Route appears to be level with good pedestrian access");
    } else {
        notes.push(`Route considerations: ${warnings.join(', ').toLowerCase()}`);
    }
    
    return notes.join('. ');
}

function calculateGPProximityScore(durationMinutes) {
    if (durationMinutes <= 5) return 5;
    if (durationMinutes <= 10) return 4;  
    if (durationMinutes <= 20) return 3;
    if (durationMinutes <= 30) return 2;
    return 1;
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

// Analyze property with Claude (including vision)
async function analyzePropertyAccessibility(property) {
    // Analyze GP proximity if coordinates available
let gpProximity = null;
if (property.coordinates) {
    console.log('Analyzing GP proximity...');
    const nearbyGPs = await findNearestGPs(property.coordinates.lat, property.coordinates.lng);
    
    if (nearbyGPs.length > 0) {
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
                walkingTime: route.duration,
                distance: route.distance,
                score: calculateGPProximityScore(route.durationMinutes),
                accessibilityNotes: route.accessibilityNotes
            };
            
            console.log('GP proximity analysis:', gpProximity);
        }
    }
}
    // Select first 5 images for analysis (to avoid timeouts)
const imagesToAnalyze = property.images.slice(0, 5);
    
    // Prepare the content array for Claude
    const content = [];
    
    // Add text description
    content.push({
        type: "text",
        text: `You are an accessibility expert specializing in homes for older adults. Analyze this property and provide scores for three criteria.

Property Details:
- Title: ${property.title}
- Price: ${property.price}
- Description: ${property.description}
- Features: ${property.features.join(', ')}
- EPC Rating: ${property.epcRating || 'Not specified'}

ANALYZE THE IMAGES for:
- Floorplans showing room layouts, stairs, accessibility
- Property photos showing windows, lighting, entrance access
- Any visual clues about heating systems, renovations

Focus on analyzing the DESCRIPTION text and IMAGES for specific details about:
- Stairs, levels, and accessibility features
- Window sizes, natural light, room layouts
- Heating systems, insulation, recent renovations

IMPORTANT: You must respond with ONLY a valid JSON object, no other text.

Score each criterion from 1-5:
1. STAIRS & ACCESSIBILITY (1=many stairs, very challenging / 5=single story, level access)
2. NATURAL LIGHT & WINDOWS (1=poor light, small windows / 5=excellent light, large windows)  
3. HEATING EFFICIENCY (1=very poor efficiency / 5=excellent efficiency)

Respond with this exact JSON format:
{
  "stairs": {
    "score": 4,
    "rating": "Good",
    "details": "Ground floor living available with minimal steps"
  },
  "light": {
    "score": 4,
    "rating": "Good", 
    "details": "Good-sized windows providing natural light"
  },
  "heating": {
    "score": 3,
    "rating": "Average",
    "details": "Standard heating system"
  },
  "overall": 3.7,
  "summary": "Brief summary of accessibility for older adults"
}`
    });

    // Add the AI-selected images for visual analysis
    imagesToAnalyze.forEach(imageUrl => {
        content.push({
            type: "image",
            source: {
                type: "url",
                url: imageUrl
            }
        });
    });

    console.log(`Analyzing ${imagesToAnalyze.length} AI-selected images with Claude Vision`);

    try {
        const response = await axios.post(CLAUDE_API_URL, {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: content
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            }
        });

        const analysisText = response.data.content[0].text;
        console.log('Claude vision analysis completed');

        // Parse the JSON response
        let analysisData;
        try {
            const cleanText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            analysisData = JSON.parse(cleanText);
        } catch (parseError) {
            const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No valid JSON found in response');
            }
            analysisData = JSON.parse(jsonMatch[0]);
        }

        return analysisData;
    } catch (error) {
        console.error('Claude API error:', error.response?.data || error.message);
        throw new Error('Failed to analyze property with AI');
    }
}

// Helper function to convert score to rating text
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

        // Step 2: Analyze with Claude
        const analysis = await analyzePropertyAccessibility(property);
        console.log('Analysis completed');

        // Ensure all required fields exist
        if (!analysis.stairs) analysis.stairs = { score: 3, rating: 'Fair', details: 'Analysis unavailable' };
        if (!analysis.light) analysis.light = { score: 3, rating: 'Fair', details: 'Analysis unavailable' };
        if (!analysis.heating) analysis.heating = { score: 3, rating: 'Fair', details: 'Analysis unavailable' };
        if (!analysis.overall) analysis.overall = 3.0;
        if (!analysis.summary) analysis.summary = 'Property analysis completed.';

        const result = {
            property: {
                title: property.title,
                price: property.price,
                url: url
            },
            analysis: analysis,
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
