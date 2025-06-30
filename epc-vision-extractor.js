// epc-vision-extractor.js
// EPC Certificate Vision Extraction for Home Accessibility Score
// Replaces flawed text-based extraction with Claude Vision API

const axios = require('axios');
const cheerio = require('cheerio');

class EPCVisionExtractor {
    constructor(claudeApiKey) {
        this.claudeApiKey = claudeApiKey;
        this.claudeApiUrl = 'https://api.anthropic.com/v1/messages';
    }

    /**
     * Main function to extract EPC rating from a Rightmove property URL
     */
    async extractEPCFromProperty(propertyUrl) {
        try {
            console.log('🔍 Starting EPC extraction for:', propertyUrl);
            
            // Step 1: Get the property page HTML
            const html = await this.fetchPropertyPage(propertyUrl);
            
            // Step 2: Find EPC certificate image URLs
            const epcImageUrls = await this.findEPCImageUrls(html, propertyUrl);
            
            if (epcImageUrls.length === 0) {
                console.log('⚠️ No EPC certificate images found');
                return { rating: null, confidence: 0, reason: 'No EPC certificate found' };
            }
            
            // Step 3: Use Claude Vision to read the EPC certificate
            const epcResult = await this.analyzeEPCWithVision(epcImageUrls[0]);
            
            console.log('✅ EPC extraction complete:', epcResult);
            return epcResult;
            
        } catch (error) {
            console.error('❌ Error extracting EPC:', error.message);
            return { rating: null, confidence: 0, reason: error.message };
        }
    }

    /**
     * Fetch the property page HTML
     */
    async fetchPropertyPage(url) {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        return response.data;
    }

    /**
     * Find EPC certificate image URLs in the HTML
     */
    async findEPCImageUrls(html, baseUrl) {
        const $ = cheerio.load(html);
        const epcImageUrls = [];
        
        // Strategy 1: Look for images with EPC-related alt text or src
        $('img').each((i, img) => {
            const src = $(img).attr('src');
            const alt = $(img).attr('alt') || '';
            const title = $(img).attr('title') || '';
            
            if (src && this.isEPCImage(src, alt, title)) {
                const fullUrl = this.resolveUrl(src, baseUrl);
                epcImageUrls.push(fullUrl);
                console.log('📋 Found EPC image:', fullUrl);
            }
        });

        // Strategy 2: Look for links to EPC certificates
        $('a').each((i, link) => {
            const href = $(link).attr('href');
            const text = $(link).text().toLowerCase();
            
            if (href && this.isEPCLink(href, text)) {
                console.log('🔗 Found EPC link:', href);
                // Could follow these links to find actual certificate images
            }
        });

        // Strategy 3: Check for embedded PDFs or document viewers
        $('iframe, embed, object').each((i, element) => {
            const src = $(element).attr('src');
            if (src && this.isEPCDocument(src)) {
                console.log('📄 Found EPC document:', src);
            }
        });

        return epcImageUrls;
    }

    /**
     * Check if an image is likely an EPC certificate
     */
    isEPCImage(src, alt, title) {
        const combined = `${src} ${alt} ${title}`.toLowerCase();
        const epcKeywords = [
            'epc', 'energy performance', 'energy certificate', 
            'energy rating', 'energy efficiency'
        ];
        
        return epcKeywords.some(keyword => combined.includes(keyword));
    }

    /**
     * Check if a link points to an EPC certificate
     */
    isEPCLink(href, text) {
        const combined = `${href} ${text}`.toLowerCase();
        return combined.includes('epc') || 
               combined.includes('energy performance') || 
               combined.includes('energy certificate') ||
               (href.includes('.pdf') && combined.includes('energy'));
    }

    /**
     * Check if a document is likely an EPC
     */
    isEPCDocument(src) {
        return src.toLowerCase().includes('epc') || 
               src.toLowerCase().includes('energy');
    }

    /**
     * Resolve relative URLs to absolute URLs
     */
    resolveUrl(url, baseUrl) {
        if (url.startsWith('http')) {
            return url;
        }
        
        try {
            const base = new URL(baseUrl);
            if (url.startsWith('/')) {
                return `${base.protocol}//${base.host}${url}`;
            }
            return `${base.protocol}//${base.host}${base.pathname}/${url}`;
        } catch (error) {
            console.error('Error resolving URL:', error.message);
            return url;
        }
    }

    /**
     * Use Claude Vision API to analyze the EPC certificate image
     */
    async analyzeEPCWithVision(imageUrl) {
        try {
            console.log('👁️ Analyzing EPC with Claude Vision:', imageUrl);
            
            // Download the image and convert to base64
            const imageData = await this.downloadImageAsBase64(imageUrl);
            
            // Prepare the Claude Vision request
            const prompt = this.buildEPCAnalysisPrompt();
            
            const response = await axios.post(this.claudeApiUrl, {
                model: 'claude-3-5-sonnet-20241022', // Cost-efficient model
                max_tokens: 300,
                messages: [{
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: prompt
                        },
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: "image/jpeg",
                                data: imageData
                            }
                        }
                    ]
                }]
            }, {
                headers: {
                    'Authorization': `Bearer ${this.claudeApiKey}`,
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                }
            });

            // Parse Claude's response
            const analysisResult = this.parseEPCAnalysis(response.data.content[0].text);
            
            return analysisResult;
            
        } catch (error) {
            console.error('❌ Vision analysis failed:', error.message);
            return { rating: null, confidence: 0, reason: 'Vision analysis failed' };
        }
    }

    /**
     * Download image and convert to base64
     */
    async downloadImageAsBase64(imageUrl) {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        
        return Buffer.from(response.data, 'binary').toString('base64');
    }

    /**
     * Build the prompt for Claude Vision to analyze the EPC certificate
     */
    buildEPCAnalysisPrompt() {
        return `Please analyze this EPC (Energy Performance Certificate) image and extract the CURRENT energy efficiency rating.

IMPORTANT INSTRUCTIONS:
1. Look for the CURRENT rating (not the potential rating)
2. The current rating will be in a colored box/section, typically on the left side
3. Extract both the letter (A, B, C, D, E, F, G) AND the numerical score if visible
4. Ignore any "Potential" ratings (usually on the right side)
5. If you see multiple ratings, choose the CURRENT one

Please respond in this exact JSON format:
{
    "rating": "D",
    "score": 59,
    "confidence": 95,
    "reason": "Found current rating D with score 59 in yellow section"
}

If you cannot clearly identify the rating, respond with:
{
    "rating": null,
    "score": null,
    "confidence": 0,
    "reason": "Could not clearly identify current EPC rating"
}`;
    }

    /**
     * Parse Claude's EPC analysis response
     */
    parseEPCAnalysis(responseText) {
        try {
            // Extract JSON from response text
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No JSON found in response');
            }
            
            const result = JSON.parse(jsonMatch[0]);
            
            // Validate the response structure
            if (!this.isValidEPCResult(result)) {
                throw new Error('Invalid response structure');
            }
            
            return result;
            
        } catch (error) {
            console.error('❌ Failed to parse EPC analysis:', error.message);
            return { 
                rating: null, 
                score: null, 
                confidence: 0, 
                reason: 'Failed to parse analysis result' 
            };
        }
    }

    /**
     * Validate the EPC analysis result structure
     */
    isValidEPCResult(result) {
        return typeof result === 'object' &&
               ('rating' in result) &&
               ('confidence' in result) &&
               ('reason' in result);
    }

    /**
     * Convert EPC rating to numerical score for accessibility scoring
     * A=90-100, B=80-89, C=70-79, D=60-69, E=50-59, F=40-49, G=0-39
     */
    convertRatingToScore(rating, score = null) {
        if (!rating) return 0;
        
        // If we have the actual numerical score, use it
        if (score && typeof score === 'number') {
            return Math.max(0, Math.min(100, score));
        }
        
        // Otherwise, use rating letter to estimate mid-range score
        const ratingScores = {
            'A': 95,
            'B': 85,
            'C': 75,
            'D': 65,
            'E': 55,
            'F': 45,
            'G': 35
        };
        
        return ratingScores[rating.toUpperCase()] || 0;
    }
}

// Export the class
module.exports = { EPCVisionExtractor };
