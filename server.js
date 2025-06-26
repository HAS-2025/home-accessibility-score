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

async function scrapeRightmoveProperty(url) {
    try {
        console.log('Scraping Rightmove URL:', url);
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Get all text content and look for patterns
        const pageText = $('body').text();
        
        // Extract property ID
        const propertyIdMatch = url.match(/properties\/(\d+)/);
        const propertyId = propertyIdMatch ? propertyIdMatch[1] : 'unknown';
        
        // Extract title from page title tag
        const fullTitle = $('title').text();
        const titleMatch = fullTitle.match(/(.+?) for sale/i);
        const title = titleMatch ? titleMatch[1].trim() : fullTitle.split('open-rightmove')[0].trim();
        
        // Look for price patterns in text
        const priceMatch = pageText.match(/£[\d,]+/g);
        const price = priceMatch ? priceMatch[0] : 'Price not available';
        
        // Look for bedroom/bathroom info
        const bedroomMatch = pageText.match(/(\d+)\s*bedroom/i);
        const bathroomMatch = pageText.match(/(\d+)\s*bathroom/i);
        
        // Build features array from what we can find
        const features = [];
        if (bedroomMatch) features.push(`${bedroomMatch[1]} bedroom${bedroomMatch[1] > 1 ? 's' : ''}`);
        if (bathroomMatch) features.push(`${bathroomMatch[1]} bathroom${bathroomMatch[1] > 1 ? 's' : ''}`);
        
        // Look for property type
        const typeMatch = pageText.match(/(detached|semi-detached|terraced|apartment|flat|bungalow|house)/i);
        if (typeMatch) features.push(typeMatch[1]);
        
        console.log('Extracted title:', title);
        console.log('Extracted price:', price);
        console.log('Extracted features:', features);
        
        return {
            id: propertyId,
            title: title,
            price: price,
            description: `Property in ${title.split(',').pop() || 'location'}. ${features.join(', ')}.`,
            features: features,
            images: [],
            floorplan: null,
            epcRating: null
        };
        
    } catch (error) {
        console.error('Scraping error:', error.message);
        throw new Error('Failed to scrape property data');
    }
}

// Analyze property with Claude
async function analyzePropertyAccessibility(property) {
    const prompt = `You are an accessibility expert specializing in homes for older adults. Analyze this property and provide scores for three criteria.

Property Details:
- Title: ${property.title}
- Price: ${property.price}
- Description: ${property.description}
- Features: ${property.features.join(', ')}
- EPC Rating: ${property.epcRating || 'Not specified'}

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
}`;

    try {
        const response = await axios.post(CLAUDE_API_URL, {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{
                role: 'user',
                content: prompt
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
            }
        });

        const analysisText = response.data.content[0].text;
        console.log('Claude response received');

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
