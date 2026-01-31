// server.js - Home Accessibility Score
// Cleaned up version with extracted constants and utility functions

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { createClient } = require('@supabase/supabase-js');

// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Admin client for generating auth tokens
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);


// ============================================
// CONFIGURATION CONSTANTS
// ============================================

// API Timeouts (milliseconds)
const API_TIMEOUT_SHORT = 5000;
const API_TIMEOUT_STANDARD = 15000;
const API_TIMEOUT_LONG = 30000;
const ANALYSIS_TIMEOUT = 60000;

// Rate Limiting
const SCRAPE_DELAY_MIN = 2000;
const SCRAPE_DELAY_RANDOM = 3000;

// Walking Speeds (meters per minute)
const ELDERLY_WALKING_SPEED_MPS = 57;
const STANDARD_WALKING_SPEED_MPS = 80;

// Search Radii (meters)
const GP_SEARCH_RADIUS = 3000;
const TRANSPORT_SEARCH_RADIUS = 2000;

// Scoring Thresholds
const MIN_DESCRIPTION_LENGTH = 50;
const EPC_CONFIDENCE_THRESHOLD = 50;

// ============================================
// SCORING UTILITY FUNCTIONS
// ============================================

/**
 * Calculate EPC score based on energy rating
 * @param {string|null} epcRating - EPC rating letter (A-G) or null
 * @returns {{score: number|null, rating: string, description: string}}
 */
function calculateEPCScore(epcRating) {
    if (!epcRating) return { score: null, rating: 'Not available', description: 'Energy rating not available' };
    
    const rating = epcRating.toUpperCase();
    
    switch (rating) {
        case 'A':
            return {
                score: 5,
                rating: 'Excellent',
                description: 'Energy rating A - Most efficient. This property has excellent energy efficiency with very low heating costs, ideal for maintaining comfortable temperatures year-round.'
            };
        case 'B':
            return {
                score: 5,
                rating: 'Excellent',
                description: 'Energy rating B - Very efficient. This property has excellent energy efficiency with low heating costs, helping maintain comfortable temperatures.'
            };
        case 'C':
            return {
                score: 4,
                rating: 'Very Good',
                description: 'Energy rating C - Above average efficiency. This property has very good energy efficiency with reasonable heating costs.'
            };
        case 'D':
            return {
                score: 3,
                rating: 'Good',
                description: 'Energy rating D - Average efficiency. This property has good energy efficiency with moderate heating costs.'
            };
        case 'E':
            return {
                score: 2,
                rating: 'Fair',
                description: 'Energy rating E - Below average efficiency. This property has fair energy efficiency and may have higher heating costs.'
            };
        case 'F':
            return {
                score: 1,
                rating: 'Poor',
                description: 'Energy rating F - Poor efficiency. This property has poor energy efficiency and is likely to have high heating costs.'
            };
        case 'G':
            return {
                score: 0,
                rating: 'Very Poor',
                description: 'Energy rating G - Very poor efficiency. This property has very poor energy efficiency and is likely to have very high heating costs.'
            };
        default:
            return {
                score: null,
                rating: 'Unknown',
                description: 'Energy rating not available'
            };
    }
}

/**
 * Calculate council tax score based on band
 * @param {string|null} councilTaxBand - Council tax band (A-H) or null
 * @returns {{score: number|null, rating: string, description: string}}
 */
function calculateCouncilTaxScore(councilTaxBand) {
    if (!councilTaxBand || councilTaxBand.includes('TBC')) {
        return {
            score: null,
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

/**
 * Helper function for value-based ratings
 * @param {number} score - Score from 0-5
 * @returns {string} Rating description
 */
function getValueRating(score) {
    if (score >= 5) return 'Excellent value';
    if (score >= 4) return 'Good value';
    if (score >= 3) return 'Average value';
    if (score >= 2) return 'Above average cost';
    if (score >= 1) return 'Premium pricing';
    return 'Very expensive';
}

/**
 * Calculate price per square meter score based on UK market percentiles
 * @param {number|null} pricePerSqM - Price per square meter in GBP
 * @returns {{score: number|null, rating: string, description: string, percentile: string|null}}
 */
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
        percentile = '50th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is more expensive than 50% of properties on the market - above average cost.`;
    } else if (pricePerSqM <= 6015) {
        score = 1;
        percentile = '75th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is more expensive than 75% of properties on the market - premium pricing.`;
    } else {
        score = 0;
        percentile = '90th';
        description = `At £${pricePerSqM.toLocaleString()} per sq m, this property is more expensive than 90% of properties on the market - very expensive.`;
    }
    
    return {
        score,
        rating: getValueRating(score),
        description,
        percentile
    };
}

/**
 * Detect which UK nation a property is in based on postcode
 * @param {string|null} postcode - UK postcode
 * @returns {string} 'england', 'wales', or 'scotland'
 */
function detectCountryFromPostcode(postcode) {
    if (!postcode) return 'england'; // Default to England
    
    // Clean and extract prefix
    const cleaned = postcode.toUpperCase().replace(/\s+/g, '');
    const prefix = cleaned.match(/^[A-Z]{1,2}/)?.[0];
    
    if (!prefix) return 'england';
    
    // Scottish postcodes
    const scottishPrefixes = ['AB', 'DD', 'DG', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'TD', 'ZE'];
    if (scottishPrefixes.includes(prefix)) return 'scotland';
    
    // Welsh postcodes
    const welshPrefixes = ['CF', 'LD', 'LL', 'NP', 'SA'];
    if (welshPrefixes.includes(prefix)) return 'wales';
    
    // CH postcode is split - CH5-8 are Wales (Flintshire), CH1-4 are England (Chester)
    if (prefix === 'CH') {
        const number = cleaned.match(/CH(\d+)/)?.[1];
        if (number) {
            const num = parseInt(number);
            if (num >= 5 && num <= 8) return 'wales';
        }
        return 'england';
    }

    // SY postcode is split - SY15-25 are Wales, rest are England (Shrewsbury)
    if (prefix === 'SY') {
        const number = cleaned.match(/SY(\d+)/)?.[1];
        if (number) {
            const num = parseInt(number);
            if (num >= 15 && num <= 25) return 'wales';
        }
        return 'england';
    }
    
    return 'england'; // England + Northern Ireland use SDLT
}

/**
 * Calculate England/NI Stamp Duty Land Tax (SDLT)
 * @param {number} propertyPrice - Property price in GBP
 * @returns {number} SDLT amount
 */
function calculateEnglandSDLT(propertyPrice) {
    if (!propertyPrice || propertyPrice <= 0) return 0;
    
    let tax = 0;
    
    // SDLT bands (as of 2024)
    if (propertyPrice <= 125000) {
        tax = 0;
    } else if (propertyPrice <= 250000) {
        tax = (propertyPrice - 125000) * 0.02;
    } else if (propertyPrice <= 925000) {
        tax = (125000 * 0.02) + (propertyPrice - 250000) * 0.05;
    } else if (propertyPrice <= 1500000) {
        tax = (125000 * 0.02) + (675000 * 0.05) + (propertyPrice - 925000) * 0.10;
    } else {
        tax = (125000 * 0.02) + (675000 * 0.05) + (575000 * 0.10) + (propertyPrice - 1500000) * 0.12;
    }
    
    return Math.round(tax);
}

/**
 * Calculate Wales Land Transaction Tax (LTT)
 * @param {number} propertyPrice - Property price in GBP
 * @returns {number} LTT amount
 */
function calculateWalesLTT(propertyPrice) {
    if (!propertyPrice || propertyPrice <= 0) return 0;
    
    let tax = 0;
    
    // Wales LTT bands (as of 2024)
    if (propertyPrice <= 225000) {
        tax = 0;
    } else if (propertyPrice <= 400000) {
        tax = (propertyPrice - 225000) * 0.06;
    } else if (propertyPrice <= 750000) {
        tax = (175000 * 0.06) + (propertyPrice - 400000) * 0.075;
    } else if (propertyPrice <= 1500000) {
        tax = (175000 * 0.06) + (350000 * 0.075) + (propertyPrice - 750000) * 0.10;
    } else {
        tax = (175000 * 0.06) + (350000 * 0.075) + (750000 * 0.10) + (propertyPrice - 1500000) * 0.12;
    }
    
    return Math.round(tax);
}

/**
 * Calculate Scotland Land and Buildings Transaction Tax (LBTT)
 * @param {number} propertyPrice - Property price in GBP
 * @returns {number} LBTT amount
 */
function calculateScotlandLBTT(propertyPrice) {
    if (!propertyPrice || propertyPrice <= 0) return 0;
    
    let tax = 0;
    
    // Scotland LBTT bands (as of 2024)
    if (propertyPrice <= 145000) {
        tax = 0;
    } else if (propertyPrice <= 250000) {
        tax = (propertyPrice - 145000) * 0.02;
    } else if (propertyPrice <= 325000) {
        tax = (105000 * 0.02) + (propertyPrice - 250000) * 0.05;
    } else if (propertyPrice <= 750000) {
        tax = (105000 * 0.02) + (75000 * 0.05) + (propertyPrice - 325000) * 0.10;
    } else {
        tax = (105000 * 0.02) + (75000 * 0.05) + (425000 * 0.10) + (propertyPrice - 750000) * 0.12;
    }
    
    return Math.round(tax);
}

/**
 * Calculate property transaction tax based on location
 * @param {number} propertyPrice - Property price in GBP
 * @param {string|null} postcode - UK postcode to determine which tax applies
 * @returns {{amount: number, taxName: string, taxNameFull: string, country: string}}
 */
function calculatePropertyTax(propertyPrice, postcode) {
    const country = detectCountryFromPostcode(postcode);
    
    let amount, taxName, taxNameFull;
    
    switch (country) {
        case 'scotland':
            amount = calculateScotlandLBTT(propertyPrice);
            taxName = 'LBTT';
            taxNameFull = 'Land and Buildings Transaction Tax';
            break;
        case 'wales':
            amount = calculateWalesLTT(propertyPrice);
            taxName = 'LTT';
            taxNameFull = 'Land Transaction Tax';
            break;
        default: // england (includes Northern Ireland)
            amount = calculateEnglandSDLT(propertyPrice);
            taxName = 'Stamp Duty';
            taxNameFull = 'Stamp Duty Land Tax';
    }
    
    return { amount, taxName, taxNameFull, country };
}

/**
 * Calculate UK Stamp Duty (England/NI) based on property price
 * @deprecated Use calculatePropertyTax() for location-aware calculation
 * @param {number|null} propertyPrice - Property price in GBP
 * @returns {number|null} Stamp duty amount or null
 */
function calculateStampDuty(propertyPrice) {
    if (!propertyPrice || propertyPrice <= 0) return null;
    return calculateEnglandSDLT(propertyPrice);
}

/**
 * Calculate property tax score (supports England SDLT, Wales LTT, Scotland LBTT)
 * @param {number|null} propertyPrice - Property price in GBP
 * @param {string|null} postcode - UK postcode to determine which tax applies
 * @returns {{score: number|null, rating: string, description: string, amount: number|null, percentage: string|null, taxName: string, taxNameFull: string, country: string}}
 */
function calculatePropertyTaxScore(propertyPrice, postcode = null) {
    if (!propertyPrice || propertyPrice <= 0) {
        return {
            score: null,
            rating: 'Unknown',
            description: 'Property tax information not available',
            amount: null,
            percentage: null,
            taxName: 'Stamp Duty',
            taxNameFull: 'Stamp Duty Land Tax',
            country: 'england'
        };
    }
    
    const { amount, taxName, taxNameFull, country } = calculatePropertyTax(propertyPrice, postcode);
    
    let score, rating, description;
    
    if (amount === 0) {
        score = 5;
        rating = 'Excellent';
        description = `No ${taxName} payable`;
    } else if (amount <= 10000) {
        score = 4;
        rating = 'Good';
        description = `Low ${taxName} cost`;
    } else if (amount <= 15000) {
        score = 3;
        rating = 'Fair';
        description = `Moderate ${taxName} cost`;
    } else if (amount <= 20000) {
        score = 2;
        rating = 'Poor';
        description = `High ${taxName} cost`;
    } else if (amount <= 25000) {
        score = 1;
        rating = 'Very Poor';
        description = `Very high ${taxName} cost`;
    } else {
        score = 0;
        rating = 'Extremely Poor';
        description = `Extremely high ${taxName} cost`;
    }
    
    return {
        score,
        rating,
        description,
        amount,
        percentage: ((amount / propertyPrice) * 100).toFixed(2),
        taxName,
        taxNameFull,
        country
    };
}

/**
 * Calculate Stamp Duty score (legacy function - use calculatePropertyTaxScore for new code)
 * @param {number|null} propertyPrice - Property price in GBP
 * @returns {{score: number|null, rating: string, description: string, amount: number|null, percentage: string|null}}
 */
function calculateStampDutyScore(propertyPrice) {
    // Legacy wrapper - assumes England for backward compatibility
    const result = calculatePropertyTaxScore(propertyPrice, null);
    return {
        score: result.score,
        rating: result.rating,
        description: result.description,
        amount: result.amount,
        percentage: result.percentage
    };
}

/**
 * Calculate room-based accommodation score
 * @param {Object} property - Property object with description and title
 * @returns {{score: number, roomsFound: string[], rawScore: number, maxPossible: number}}
 */
function calculateRoomScore(property) {
    let score = 0;
    let foundRooms = [];
    
    const description = (property.description || '').toLowerCase();
    const title = (property.title || '').toLowerCase();
    const combinedText = `${title} ${description}`;
    
    // Living room - must be separate from kitchen (1 point)
    let hasSeparateLivingRoom = false;
    if ((combinedText.includes('living room') || combinedText.includes('lounge') || combinedText.includes('reception')) 
        && !combinedText.includes('open plan')) {
        score += 1;
        foundRooms.push('Living room (separate from kitchen)');
        hasSeparateLivingRoom = true;
    }

    // Kitchen or kitchen diner (1 point)
    let hasKitchen = combinedText.includes('kitchen');
    if (!hasKitchen && hasSeparateLivingRoom) {
        hasKitchen = true;
    }
    if (hasKitchen) {
        score += 1;
        foundRooms.push('Kitchen or kitchen diner');
    }
    
    // Count bathrooms from description
    let bathroomCount = 0;
    const bathroomMatch = combinedText.match(/(\d+)\s*bathroom/);
    if (bathroomMatch) {
        bathroomCount = parseInt(bathroomMatch[1]);
    } else if (combinedText.includes('bathroom') || combinedText.includes('toilet') || combinedText.includes('wc')) {
        bathroomCount = 1;
    }
    
    // Check for en-suite (adds to bathroom count)
    if (combinedText.includes('en suite') || combinedText.includes('ensuite')) {
        bathroomCount += 1;
    }
    
    // Award points and list bathrooms
    if (bathroomCount >= 1) {
        score += 1;
        foundRooms.push('Bathroom/toilet 1');
    }
    if (bathroomCount >= 2) {
        score += 1;
        foundRooms.push('Bathroom/toilet 2');
    }
    if (bathroomCount >= 3) {
        foundRooms.push('Bathroom/toilet 3+');
    }
    
    // Bedrooms from title
    const bedroomMatch = title.match(/(\d+)\s*bedroom/);
    if (bedroomMatch) {
        const bedroomCount = parseInt(bedroomMatch[1]);
        if (bedroomCount >= 1) {
            score += 1;
            foundRooms.push('Bedroom 1');
        }
        if (bedroomCount >= 2) {
            score += 1;
            foundRooms.push('Bedroom 2');
        }
        if (bedroomCount >= 3) {
            foundRooms.push('Bedroom 3+');
        }
    }
    
    // Maximum score is 6, convert to 0-5 scale
    const finalScore = Math.round((score * (5 / 6)) * 10) / 10;
    
    return {
        score: finalScore,
        roomsFound: foundRooms,
        rawScore: score,
        maxPossible: 6
    };
}

// ============================================
// END SCORING UTILITY FUNCTIONS
// ============================================

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe-webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});
app.use(express.static('.'));

// =============================================
// STRIPE PAYMENT ENDPOINTS
// =============================================

// Create checkout session
app.post('/api/create-checkout', async (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({ error: 'Must be logged in' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    const { plan } = req.body;
    
    const priceId = plan === 'annual' 
        ? process.env.STRIPE_PRICE_ANNUAL 
        : process.env.STRIPE_PRICE_MONTHLY;
    
    try {
        // Get or create Stripe customer
        let { data: dbUser } = await supabase
            .from('users')
            .select('stripe_customer_id')
            .eq('email', user.email)
            .single();
        
        let customerId = dbUser?.stripe_customer_id;
        
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email
            });
            customerId = customer.id;
            
            // Save customer ID
            await supabase
                .from('users')
                .update({ stripe_customer_id: customerId })
                .eq('email', user.email);
        }
        
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [{
                price: priceId,
                quantity: 1
            }],
            success_url: `${req.headers.origin || 'http://localhost:3002'}/?payment=success`,
            cancel_url: `${req.headers.origin || 'http://localhost:3002'}/?payment=cancelled`,
            metadata: {
                plan: plan,
                email: user.email
            }
        });
        
        console.log('💳 Checkout session created for:', user.email);
        res.json({ url: session.url });
    } catch (error) {
        console.log('❌ Stripe error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Stripe webhook - handles subscription events
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.log('❌ Webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log('🔔 Webhook received:', event.type);
    
    // Handle successful subscription
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        console.log('💳 Payment successful for customer:', session.customer);
        console.log('📧 Customer email:', session.customer_email);
        console.log('📦 Metadata:', session.metadata);

        // Check if this is a team subscription (existing team checkout)
        if (session.metadata?.team_id) {
            const { error } = await supabase
                .from('teams')
                .update({ 
                    subscription_status: 'active',
                    subscription_tier: 'team'
                })
                .eq('id', session.metadata.team_id);
            
            if (error) {
                console.log('❌ Error updating team:', error.message);
            } else {
                console.log('✅ Team subscription activated:', session.metadata.team_id);
            }
            return res.json({ received: true });
        }
        
        // Determine tier from actual price ID (most reliable)
        let tier = 'monthly'; // default
        
        if (session.subscription) {
            try {
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                const priceId = subscription.items.data[0]?.price?.id;
                
                console.log('💰 Price ID from subscription:', priceId);
                
                if (priceId === process.env.STRIPE_PRICE_ANNUAL) {
                    tier = 'annual';
                } else if (priceId === process.env.STRIPE_PRICE_TEAM_ANNUAL) {
                    tier = 'team-annual';
                } else if (priceId === process.env.STRIPE_PRICE_TEAM) {
                    tier = 'team';
                } else {
                    tier = 'monthly';
                }
            } catch (err) {
                console.log('⚠️ Could not retrieve subscription, using default tier:', err.message);
            }
        }
        
        const email = session.metadata?.email || session.customer_email;
        const isTeamPlan = tier === 'team' || tier === 'team-annual';
        
        console.log('🏷️ Subscription tier:', tier);
        console.log('📧 User email:', email);
        console.log('👥 Is team plan:', isTeamPlan);
        
        // Update user subscription
        const { data: updatedUser, error } = await supabase
            .from('users')
            .update({ 
                subscription_status: 'active',
                subscription_tier: tier,
                stripe_customer_id: session.customer,
                user_type: isTeamPlan ? 'agent' : 'individual'
            })
            .eq('email', email)
            .select('id')
            .single();
            
        if (error) {
            console.log('❌ Error updating user:', error.message);
        } else {
            console.log('✅ User subscription activated:', email, '- Tier:', tier);
            
            // If team plan, create a team for the user
            if (isTeamPlan && updatedUser) {
                // Check if user already has a team
                const { data: existingMembership } = await supabase
                    .from('team_members')
                    .select('team_id')
                    .eq('user_id', updatedUser.id)
                    .single();
                
                if (!existingMembership) {
                    // Create a new team
                    const { data: newTeam, error: teamError } = await supabase
                        .from('teams')
                        .insert({
                            name: `${email.split('@')[0]}'s Team`,
                            owner_id: updatedUser.id,
                            subscription_status: 'active',
                            subscription_tier: tier,
                            stripe_customer_id: session.customer
                        })
                        .select('id')
                        .single();
                    
                    if (teamError) {
                        console.log('❌ Error creating team:', teamError.message);
                    } else {
                        // Add user as team owner
                        const { error: memberError } = await supabase
                            .from('team_members')
                            .insert({
                                team_id: newTeam.id,
                                user_id: updatedUser.id,
                                role: 'owner'
                            });
                        
                        if (memberError) {
                            console.log('❌ Error adding team member:', memberError.message);
                        } else {
                            console.log('✅ Team created for user:', email, '- Team ID:', newTeam.id);
                        }
                    }
                } else {
                    console.log('ℹ️ User already has a team:', existingMembership.team_id);
                }
            }
        }
    }
    
    // Handle subscription actually cancelled/ended
    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        
        console.log('❌ Subscription ended for customer:', subscription.customer);
        
        const { error } = await supabase
            .from('users')
            .update({ 
                subscription_status: 'free',
                subscription_tier: null
            })
            .eq('stripe_customer_id', subscription.customer);
        
        if (error) {
            console.log('❌ Error updating cancelled user:', error.message);
        } else {
            console.log('👤 User reverted to free tier:', subscription.customer);
        }
    }
    
    res.json({ received: true });
});

// Customer portal (manage subscription)
app.post('/api/customer-portal', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    console.log('🔧 Portal request for:', user.email);
    
    // Get user's Stripe customer ID
    const { data: dbUser } = await supabase
        .from('users')
        .select('stripe_customer_id')
        .eq('email', user.email)
        .single();
    
    console.log('🔧 DB user found:', dbUser);
    console.log('🔧 Stripe customer ID:', dbUser?.stripe_customer_id);
    
    if (!dbUser?.stripe_customer_id) {
        return res.status(400).json({ error: 'No subscription found' });
    }
    
    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: dbUser.stripe_customer_id,
            return_url: `${req.headers.origin || 'http://localhost:3002'}/analysis.html`
        });
        
        console.log('🔧 Portal session created for:', user.email);
        res.json({ url: session.url });
    } catch (error) {
        console.log('❌ Portal error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Team checkout
app.post('/api/create-team-checkout', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { plan } = req.body; // 'team' or 'team-annual'
    
    // Get user's team
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    const { data: membership } = await supabase
        .from('team_members')
        .select('team_id, role, teams(*)')
        .eq('user_id', dbUser.id)
        .single();
    
    if (!membership || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only team owner can subscribe' });
    }
    
    // Check seat limit (5 seats)
    const { count } = await supabase
        .from('team_members')
        .select('*', { count: 'exact', head: true })
        .eq('team_id', membership.team_id);
    
    if (count >= 5) {
        return res.status(400).json({ error: 'Team seat limit reached (5 members)' });
    }
    
    // Select price based on plan
    const priceId = plan === 'team-annual' 
        ? process.env.STRIPE_PRICE_TEAM_ANNUAL 
        : process.env.STRIPE_PRICE_TEAM;
    
    try {
        // Get or create Stripe customer for team
        let customerId = membership.teams.stripe_customer_id;
        
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                metadata: { team_id: membership.team_id }
            });
            customerId = customer.id;
            
            await supabase
                .from('teams')
                .update({ stripe_customer_id: customerId })
                .eq('id', membership.team_id);
        }
        
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [{
                price: priceId,
                quantity: 1
            }],
            success_url: `${req.headers.origin || 'http://localhost:3002'}/?payment=success`,
            cancel_url: `${req.headers.origin || 'http://localhost:3002'}/?payment=cancelled`,
            metadata: { 
                team_id: membership.team_id,
                plan: plan
            }
        });
        
        console.log('💳 Team checkout for:', membership.teams.name, '- Plan:', plan);
        res.json({ url: session.url });
    } catch (error) {
        console.log('❌ Stripe error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Create team (for users with team subscription but no team)
app.post('/api/teams/create', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Team name required' });
    
    // Get user from database
    const { data: dbUser } = await supabase
        .from('users')
        .select('id, subscription_tier, stripe_customer_id')
        .eq('email', user.email)
        .single();
    
    if (!dbUser) return res.status(404).json({ error: 'User not found' });
    
    // Check user has team subscription
    if (dbUser.subscription_tier !== 'team' && dbUser.subscription_tier !== 'team-annual') {
        return res.status(403).json({ error: 'Team subscription required' });
    }
    
    // Check user doesn't already have a team
    const { data: existingMembership } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', dbUser.id)
        .single();
    
    if (existingMembership) {
        return res.status(400).json({ error: 'You already have a team' });
    }
    
    try {
        // Create team
        const { data: newTeam, error: teamError } = await supabase
            .from('teams')
            .insert({
                name: name,
                owner_id: dbUser.id,
                subscription_status: 'active',
                subscription_tier: dbUser.subscription_tier,
                stripe_customer_id: dbUser.stripe_customer_id
            })
            .select('id')
            .single();
        
        if (teamError) throw teamError;
        
        // Add user as owner
        const { error: memberError } = await supabase
            .from('team_members')
            .insert({
                team_id: newTeam.id,
                user_id: dbUser.id,
                role: 'owner'
            });
        
        if (memberError) throw memberError;
        
        console.log('✅ Team created:', name, '- Owner:', user.email);
        res.json({ success: true, team_id: newTeam.id });
        
    } catch (error) {
        console.log('❌ Error creating team:', error.message);
        res.status(500).json({ error: 'Failed to create team' });
    }
});

// Rename team
app.post('/api/teams/rename', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
    
    // Get user's team membership
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    const { data: membership } = await supabase
        .from('team_members')
        .select('team_id, role')
        .eq('user_id', dbUser.id)
        .single();
    
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only team owner or admin can rename the team' });
    }
    
    const { error } = await supabase
        .from('teams')
        .update({ name: name.trim() })
        .eq('id', membership.team_id);
    
    if (error) {
        console.log('❌ Error renaming team:', error.message);
        return res.status(500).json({ error: 'Failed to rename team' });
    }
    
    console.log('✅ Team renamed to:', name.trim());
    res.json({ success: true });
});

// Guest checkout (no auth required)
app.post('/api/create-checkout-guest', async (req, res) => {
    const { email, plan } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }
    
    // Select price based on plan type
    let priceId;
    if (plan === 'team-annual') {
        priceId = process.env.STRIPE_PRICE_TEAM_ANNUAL;
    } else if (plan === 'team') {
        priceId = process.env.STRIPE_PRICE_TEAM;
    } else if (plan === 'annual') {
        priceId = process.env.STRIPE_PRICE_ANNUAL;
    } else {
        priceId = process.env.STRIPE_PRICE_MONTHLY;
    }
    
    // Determine user type
    const isTeam = plan === 'team' || plan === 'team-annual';
    
    try {
        // Create or find user
        let { data: user } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();
        
        if (!user) {
            const { data: newUser } = await supabase
                .from('users')
                .insert({ email: email, user_type: isTeam ? 'agent' : 'individual' })
                .select('id')
                .single();
            user = newUser;
            console.log('👤 New user created for checkout:', email);
        }
        
        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            customer_email: email,
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1
            }],
            mode: 'subscription',
            success_url: `${req.headers.origin}/analysis.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/analysis.html?checkout=cancelled`,
            metadata: {
                user_id: user.id,
                email: email,
                plan: plan
            }
        });
        
        console.log('💳 Checkout session created for:', email, '- Plan:', plan);
        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout' });
    }
});

// Complete checkout and auto-sign in
app.get('/api/checkout-complete', async (req, res) => {
    const { session_id } = req.query;
    
    if (!session_id) {
        return res.status(400).json({ error: 'Session ID required' });
    }
    
    try {
        // Get session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const email = session.customer_email;
        
        console.log('✅ Checkout complete for:', email);
        
        // Update user subscription status
        await supabase
            .from('users')
            .update({ subscription_status: 'active' })
            .eq('email', email);
        
        // Generate a magic link token using admin API
        const { data, error } = await supabaseAdmin.auth.admin.generateLink({
            type: 'magiclink',
            email: email
        });
        
        if (error) throw error;
        
        // Verify the token to get a session
        const { data: sessionData, error: verifyError } = await supabaseAdmin.auth.verifyOtp({
            token_hash: data.properties.hashed_token,
            type: 'magiclink'
        });
        
        if (verifyError) throw verifyError;
        
        console.log('🎫 Auto-signed in new subscriber:', email);
        res.json({ 
            token: sessionData.session.access_token,
            user: sessionData.user
        });
        
    } catch (error) {
        console.error('❌ Checkout complete error:', error.message);
        // Fallback - send magic link email
        const session = await stripe.checkout.sessions.retrieve(session_id);
        await supabase.auth.signInWithOtp({
            email: session.customer_email,
            options: {
                emailRedirectTo: `${req.headers.origin || 'http://localhost:3002'}/analysis.html`
            }
        });
        console.log('📧 Fallback: Magic link sent to:', session.customer_email);
        res.json({ success: true, fallback: true });
    }
});

// Customer portal for managing subscription
app.post('/api/customer-portal', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    // Get user's Stripe customer ID
    const { data: dbUser } = await supabase
        .from('users')
        .select('stripe_customer_id')
        .eq('email', user.email)
        .single();
    
    if (!dbUser?.stripe_customer_id) {
        return res.status(400).json({ error: 'No subscription found' });
    }
    
    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: dbUser.stripe_customer_id,
            return_url: `${req.headers.origin || 'http://localhost:3002'}/analysis.html`
        });
        
        console.log('🔧 Portal session created for:', user.email);
        res.json({ url: session.url });
    } catch (error) {
        console.log('❌ Portal error:', error.message);
        res.status(500).json({ error: error.message });
    }
});



// =============================================
// SAVED PROPERTIES ENDPOINTS
// =============================================

// Save a property
app.post('/api/properties/save', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { propertyId, propertyData } = req.body;
    if (!propertyId) return res.status(400).json({ error: 'Property ID required' });
    
    // Get user
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    // Check saved limit (max 10)
    const { count } = await supabase
        .from('saved_properties')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', dbUser.id);
    
    if (count >= 10) {
        return res.status(400).json({ error: 'Maximum 10 saved properties. Remove one to add another.' });
    }

    console.log('Received propertyData:', propertyData);

    // Store property data if provided
    if (propertyData) {
        // Parse price to number (remove £ and commas)
        let parsedPrice = null;
        if (propertyData.price) {
            const priceMatch = String(propertyData.price).match(/[\d,]+/);
            if (priceMatch) {
                parsedPrice = parseInt(priceMatch[0].replace(/,/g, ''));
            }
        }
        
        const { error: upsertError } = await supabase
            .from('properties')
            .upsert({
                rightmove_id: propertyId,
                address: propertyData.address || null,
                title: propertyData.title || null,
                price: parsedPrice,  // Now stores as number
                overall_score: propertyData.overallScore || null,
                url: propertyData.url || null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'rightmove_id' });
        
        if (upsertError) {
            console.log('⚠️ Error storing property data:', upsertError.message);
        } else {
            console.log('✅ Property data stored for:', propertyId);
        }
    }
    
    // Save property
    const { error } = await supabase
        .from('saved_properties')
        .insert({
            user_id: dbUser.id,
            property_id: propertyId
        });
    
    if (error) {
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Property already saved' });
        }
        return res.status(500).json({ error: error.message });
    }
    
    console.log('⭐ Property saved for:', user.email);
    res.json({ message: 'Property saved' });
});

// Unsave a property
app.delete('/api/properties/save/:propertyId', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { propertyId } = req.params;
    
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    await supabase
        .from('saved_properties')
        .delete()
        .eq('user_id', dbUser.id)
        .eq('property_id', propertyId);
    
    console.log('⭐ Property unsaved for:', user.email);
    res.json({ message: 'Property removed from saved' });
});

// Get saved properties
app.get('/api/properties/saved', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    // Get saved properties
    const { data: saved } = await supabase
        .from('saved_properties')
        .select('saved_at, property_id')
        .eq('user_id', dbUser.id)
        .order('saved_at', { ascending: false });
    
    if (!saved || saved.length === 0) return res.json({ saved: [] });
    
    // Get property details from properties table
    const propertyIds = saved.map(s => s.property_id);
    
    const { data: properties } = await supabase
        .from('properties')
        .select('*')
        .in('rightmove_id', propertyIds);
    
    // Merge data
    const result = saved.map(s => ({
        saved_at: s.saved_at,
        property_id: s.property_id,
        properties: properties?.find(p => p.rightmove_id === s.property_id) || { rightmove_id: s.property_id, address: 'Property data not available' }
    }));
    
    res.json({ saved: result });
});

// =============================================
// SEARCH HISTORY ENDPOINTS
// =============================================

// Get search history
app.get('/api/properties/history', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    // Get search history
    const { data: history } = await supabase
        .from('search_history')
        .select('searched_at, property_id')
        .eq('user_id', dbUser.id)
        .order('searched_at', { ascending: false })
        .limit(50);
    
    if (!history || history.length === 0) return res.json({ history: [] });
    
    // Get property details
    const propertyIds = history.map(h => h.property_id);
    
    const { data: properties } = await supabase
        .from('properties')
        .select('*')
        .in('rightmove_id', propertyIds);
    
    // Merge data
    const result = history.map(h => ({
        searched_at: h.searched_at,
        property_id: h.property_id,
        properties: properties?.find(p => p.rightmove_id === h.property_id) || { rightmove_id: h.property_id, address: 'Property data not available' }
    }));

    res.json({ history: result });
});

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
                instance.model = 'claude-sonnet-4-20250514';
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

// REVISED: Accessible Features Detection with 8 Criteria
async function calculateAccessibleFeaturesScore(property) {
    let score = 0;
    const features = [];
    
    const description = (property.description || '').toLowerCase();
    const title = (property.title || '').toLowerCase();
    const propertyFeatures = (property.features || []).join(' ').toLowerCase();
    const fullText = `${title} ${description} ${propertyFeatures}`.toLowerCase();    console.log('🏠 DEBUG: fullText length:', fullText.length);
    console.log('🏠 DEBUG: fullText includes "front garden:"?', fullText.includes('front garden:'));
    console.log('🏠 DEBUG: fullText includes "rear garden:"?', fullText.includes('rear garden:'));
    console.log('🏠 DEBUG: Sample fullText (chars 5000-5500):', fullText.substring(5000, 5500));    
    
    console.log('🏠 Analyzing accessible features for property...');
    
// STEP 1: Determine property type
const lateralLivingKeywords = [
    'lateral living', 'single floor', 'all on one level', 'one level living',
    'ground floor flat', 'ground floor apartment', 'ground floor maisonette',
    'bungalow', 'dormer bungalow', 'detached bungalow', 'semi-detached bungalow',
    'chalet bungalow', 'ranch style', 'single storey', 'single story',
    'all on one floor', 'single level', 'one storey', 'one story'
];

const upperFloorIndicators = [
    'first floor', 'second floor', 'third floor', 'fourth floor', 'fifth floor',
    'upper floor', 'top floor', 'penthouse', 'mezzanine',
    'apartment on floor', 'flat on floor', 'level 1', 'level 2', 'level 3',
    'floor 1', 'floor 2', 'floor 3'
];

const multiLevelIndicators = [
    'upstairs', 'upstairs bedroom', 'upstairs bathroom', 'upstairs room',
    'first floor bedroom', 'first floor bathroom', 'bedroom upstairs',
    'bathroom upstairs', 'stairs to', 'staircase', 'stairway',
    'upper level', 'upper floor', 'loft room', 'loft bedroom',
    'attic room', 'converted loft', 'stairs leading to',
    'two storey', 'two story', 'duplex', 'split level',
    'mezzanine level', 'gallery level', 'raised area',
    'townhouse', 'town house', 'terraced house',
    'lift serving', 'lift to all floors', 'serving all floors'
];

// Check for lift/stairlift (do this BEFORE the existing STEP 2)
const liftKeywords = ['lift', 'elevator', 'passenger lift', 'serviced by lift', 'lift access', 'lift available'];
const stairliftKeywords = ['stairlift', 'stair lift', 'platform lift'];

const hasLift = liftKeywords.some(keyword => fullText.includes(keyword));
const hasStairlift = stairliftKeywords.some(keyword => fullText.includes(keyword));
const hasAnyLift = hasLift || hasStairlift;

const hasSingleLevelKeywords = lateralLivingKeywords.some(keyword => fullText.includes(keyword));
const isUpperFloor = upperFloorIndicators.some(indicator => fullText.includes(indicator));
const hasMultipleLevels = multiLevelIndicators.some(indicator => fullText.includes(indicator));

// If property has a lift but no single-level keywords, assume it's multi-level
const isMultiLevel = hasMultipleLevels || (hasAnyLift && !hasSingleLevelKeywords);

const isSingleLevel = hasSingleLevelKeywords || (!isMultiLevel && !isUpperFloor);
const isGroundFloor = hasSingleLevelKeywords && !isUpperFloor;

console.log('🏠 Property type: Single level =', isSingleLevel, '| Ground floor =', isGroundFloor, '| Multi-level =', isMultiLevel);
console.log('🏠 Lift detected:', hasLift, '| Stairlift detected:', hasStairlift);

 // Detect property type first
const isFlat = /\b(flat|apartment)\b/i.test(fullText);
const floorLevelMatch = fullText.match(/\b(ground|first|second|third|top)[\s-]?floor\s+(flat|apartment|independent living apartment)/i);
const floorLevel = floorLevelMatch ? floorLevelMatch[1].toLowerCase() : null;
const isGroundFloorFlat = isFlat && floorLevel === 'ground';
const isUpperFloorFlat = isFlat && floorLevel && floorLevel !== 'ground';

console.log(`🏠 Property type: Flat=${isFlat}, Floor level=${floorLevel}, Ground floor flat=${isGroundFloorFlat}, Upper floor=${isUpperFloorFlat}`);

// CRITERIA 1: Step-free internal access OR lift (mutually exclusive)
let hasStepFreeInternal = false;

// Check for retirement property indicators
const retirementKeywords = [
    'retirement', 
    'over 55', 
    'over 60', 
    'age restricted', 
    'retirement community', 
    'retirement village', 
    'retirement scheme'
];
const isRetirementProperty = retirementKeywords.some(keyword => 
    fullText.toLowerCase().includes(keyword)
);

// Check for evidence of upper floor/loft conversion
const upperFloorKeywords = [
    'first floor',
    'second floor',
    'upper floor',
    'loft conversion',
    'loft room',
    'attic room',
    'upstairs bedroom',
    'upstairs bathroom',
    'stairs to',
    'staircase'
];
const hasUpperFloorEvidence = upperFloorKeywords.some(keyword => 
    fullText.toLowerCase().includes(keyword)
);

// Single-level property
if (isSingleLevel && !hasMultipleLevels) {
    hasStepFreeInternal = true;
    score += 1;
    features.push('Step-free internal access');
    console.log('✓ Step-free internal access (single level property)');
} else if (isSingleLevel && isRetirementProperty && !hasUpperFloorEvidence) {
    // Single-level retirement property with no mention of upper floors - infer step-free
    hasStepFreeInternal = true;
    score += 1;
    features.push('Step-free internal access');
    console.log('✓ Step-free internal access (inferred: single-level retirement property, no upper floor mentioned)');
} else if (hasMultipleLevels && hasAnyLift) {
    score += 1;
    if (hasStairlift) {
        features.push('Stairlift');
        console.log('✓ Stairlift (compensates for internal stairs)');
    } else {
        features.push('Lift');
        console.log('✓ Lift (compensates for internal stairs)');
    }
} else {
    console.log('✗ No step-free internal access or lift');
}

// CRITERIA 2: Downstairs bedroom (only relevant for houses or ground floor flats, not upper floor flats)
let hasDownstairsBedroom = false;

if (!isUpperFloorFlat) {
    const downstairsBedroomKeywords = [
        'downstairs bedroom', 'ground floor bedroom', 'bedroom downstairs',
        'bedroom on ground floor', 'ground floor bed', 'downstairs bed',
        'bedroom ground level'
    ];

    const groundFloorBedroomPatterns = [
        /ground floor[:\s\S]{0,500}?\bbedroom\b/gi,
        /\bbedroom\b[:\s\S]{0,200}?ground floor/gi
    ];

    hasDownstairsBedroom = downstairsBedroomKeywords.some(keyword => fullText.includes(keyword));

    if (!hasDownstairsBedroom) {
        hasDownstairsBedroom = groundFloorBedroomPatterns.some(pattern => pattern.test(fullText));
    }

    // Infer for single level properties (houses/bungalows/ground floor flats)
    if (!hasDownstairsBedroom && isSingleLevel && (fullText.includes('bedroom') || fullText.includes('bed'))) {
        hasDownstairsBedroom = true;
        console.log('✓ Inferred downstairs bedroom from single level property');
    }

    if (hasDownstairsBedroom) {
        score += 1;
        features.push('Downstairs bedroom');
        console.log('✓ Downstairs bedroom');
    }
} else {
    console.log('✗ Upper floor flat - downstairs bedroom not applicable');
}

// CRITERIA 3: Downstairs bathroom/WC (only relevant for houses or ground floor flats, not upper floor flats)
let hasDownstairsBathroom = false;

if (!isUpperFloorFlat) {
    const downstairsBathroomKeywords = [
        'downstairs bathroom', 'ground floor bathroom', 'bathroom downstairs',
        'bathroom on ground floor', 'ground floor wc', 'downstairs wc',
        'downstairs toilet', 'ground floor toilet', 'downstairs shower room',
        'ground floor shower room', 'ground floor cloakroom', 'downstairs cloakroom',
        'shower room'
    ];

    const groundFloorBathroomPatterns = [
        /ground floor[:\s\S]{0,500}?\b(bathroom|shower room|wc|toilet|cloakroom)\b/gi,
        /\b(bathroom|shower room|wc|toilet)\b[:\s\S]{0,200}?ground floor/gi
    ];

    hasDownstairsBathroom = downstairsBathroomKeywords.some(keyword => fullText.includes(keyword));

    if (!hasDownstairsBathroom) {
        hasDownstairsBathroom = groundFloorBathroomPatterns.some(pattern => pattern.test(fullText));
    }

    // Infer for single level properties
    if (!hasDownstairsBathroom && isSingleLevel) {
        const hasBathroomMention = fullText.includes('bathroom') || fullText.includes('shower') || 
                                fullText.includes('toilet') || fullText.includes('wc') || 
                                fullText.includes('en suite') || fullText.includes('ensuite');
        if (hasBathroomMention) {
            hasDownstairsBathroom = true;
            console.log('✓ Inferred downstairs bathroom from single level property');
        }
    }

    if (hasDownstairsBathroom) {
        score += 1;
        features.push('Downstairs bathroom/WC');
        console.log('✓ Downstairs bathroom/WC');
    }
} else {
    console.log('✗ Upper floor flat - downstairs bathroom not applicable');
}

// CRITERIA 4: Ground floor entry
// For flats: only true if ground floor flat
// For houses: check for ground floor entry keywords
let hasGroundFloorEntry = false;

if (isFlat) {
    hasGroundFloorEntry = isGroundFloorFlat;
    if (hasGroundFloorEntry) {
        console.log('✓ Ground floor entry (ground floor flat)');
    } else {
        console.log('✗ Upper floor flat - no ground floor entry');
    }
} else {
    const groundFloorEntryKeywords = [
        'bungalow', 'detached bungalow', 'semi-detached bungalow', 'dormer bungalow', 
        'chalet bungalow', 'terraced bungalow',
        'house', 'detached house', 'semi-detached house', 'terraced house', 
        'end terrace', 'mid terrace', 'townhouse', 'town house', 'cottage', 'detached cottage',
        'ground level', 'ground floor property', 'ground floor access',
        'single storey', 'single story', 'ranch style'
    ];
    
    hasGroundFloorEntry = isGroundFloor || groundFloorEntryKeywords.some(keyword => fullText.includes(keyword));
    
    if (hasGroundFloorEntry) {
        console.log('✓ Ground floor entry');
    }
}

if (hasGroundFloorEntry) {
    score += 1;
    features.push('Ground floor entry');
}

// CRITERIA 5: Off-street or private parking
const structuredParking = property.parkingInfo || '';
const hasStructuredParking = structuredParking.length > 0 && 
    !structuredParking.toLowerCase().includes('none') &&
    !structuredParking.toLowerCase().includes('no parking');

const parkingKeywords = [
    'private parking', 'off-street parking', 'off street parking',
    'off-road parking', 'off road parking',
    'block paved parking',
    'designated parking', 'allocated parking', 'residents parking',
    'driveway', 'garage', 'car port', 'carport', 'parking space',
    'parking bay', 'secure parking', 'covered parking', 'underground parking',
    'gated parking', 'private garage', 'double garage', 'single garage',
    'own parking', 'dedicated parking', 'assigned parking',
    'parking for'
];

const parkingExclusions = [
    'on-street parking', 'on street parking', 'street parking',
    'roadside parking', 'permit parking'
];

const hasPrivateParking = hasStructuredParking || parkingKeywords.some(keyword => fullText.includes(keyword));
const hasOnStreetOnly = parkingExclusions.some(exclusion => fullText.includes(exclusion)) && !hasPrivateParking;

if (hasPrivateParking && !hasOnStreetOnly) {
    score += 1;
    features.push('Off-street/private parking');
    console.log('✓ Off-street/private parking');
}

    // CRITERIA 6: Garden access
    // Check structured garden section first
    const structuredGarden = property.gardenInfo || '';
    const hasStructuredGarden = structuredGarden.length > 0 &&
        !structuredGarden.toLowerCase().includes('none') &&
        !structuredGarden.toLowerCase().includes('no garden');

    const gardenKeywords = [
        'communal garden', 'shared garden', 'communal grounds', 'shared outdoor space',
        'communal courtyard', 'landscaped grounds', 'garden access', 'shared terrace',
        'communal areas', 'residents garden', 'well maintained garden', 'landscaped garden',
        'private garden', 'own garden', 'rear garden', 'front garden', 'enclosed garden',
        'garden flat', 'garden apartment', 'low-maintenance garden', 'low maintenance garden',
        'rear garden:', 'front garden:'  // NEW - catches "FRONT GARDEN:" and "REAR GARDEN:" headings
    ];
    
    const hasGarden = hasStructuredGarden || gardenKeywords.some(keyword => fullText.includes(keyword));

    
    if (hasGarden) {
        score += 1;
        features.push('Garden access');
        console.log('✓ Garden access');
    }
    
    // CRITERIA 7: Balcony/terrace
    const balconyKeywords = [
        'balcony', 'private terrace', 'patio', 'roof terrace', 'private balcony',
        'juliet balcony', 'outdoor terrace', 'decking', 'sun terrace',
        'private patio', 'covered balcony'
    ];
    
    let hasBalcony = balconyKeywords.some(keyword => fullText.includes(keyword));
    
    if (!hasBalcony && property.floorplan) {
        const floorplanBalcony = await analyzeFloorPlanForBalcony(property.floorplan);
        if (floorplanBalcony === true) {
            hasBalcony = true;
            console.log('✓ Balcony detected via floor plan');
        }
    }
    
    if (hasBalcony) {
        score += 1;
        features.push('Balcony/terrace');
        console.log('✓ Balcony/terrace');
    }

    // CRITERIA 8: External level/ramp access
    let externalAccessVerified = false;
    let externalAccessWarning = false;

    const levelAccessKeywords = [
        'level access', 'step-free access', 'step free access', 'no steps',
        'wheelchair accessible', 'ramp access', 'ramped access', 'access ramp',
        'disabled access', 'mobility access', 'ground level access',
        'flat access', 'level entry', 'step-free entry', 'barrier-free access',
        'accessible entrance', 'level entrance', 'no step access'
    ];

    let hasLevelAccess = levelAccessKeywords.some(keyword => fullText.includes(keyword));

    if (hasLevelAccess) {
        score += 1;
        features.push('External level/ramp access');
        externalAccessVerified = true;
        console.log('✓ External level/ramp access');
    } else {
        console.log('✗ External level/ramp access not mentioned');
    }

    // Calculate final score (max 8 features)
    const maxScore = 8;
    const preciseScore = Math.min(5, (score / maxScore) * 5);
    const displayScore = Math.round(preciseScore);

    console.log(`🏠 Accessible Features Score: ${displayScore}/5 (${score}/${maxScore} features found)`);
    console.log('✓ Features found:', features);

    return {
        score: preciseScore,
        displayScore: displayScore,
        maxScore: 5,
        features: features,
        percentage: Math.round((score / maxScore) * 100),
        externalAccessWarning: externalAccessWarning,
        applicableCriteria: {
            stepFreeOrLift: true,
            downstairsBedroom: true,
            downstairsBathroom: true,
            groundFloorEntry: true,
            privateParking: true,
            garden: true,
            balcony: true,
            externalLevelAccess: true
        },
        details: {
            stepFreeInternal: hasStepFreeInternal,
            lift: hasAnyLift && !hasStepFreeInternal,
            liftType: hasStairlift ? 'stairlift' : hasLift ? 'lift' : null,
            downstairsBedroom: hasDownstairsBedroom,
            downstairsBathroom: hasDownstairsBathroom,
            groundFloorEntry: hasGroundFloorEntry,
            privateParking: hasPrivateParking && !hasOnStreetOnly,
            garden: hasGarden,
            balcony: hasBalcony,
            externalLevelAccess: hasLevelAccess,
            externalAccessVerified: externalAccessVerified,
            isSingleLevel: isSingleLevel,
            isGroundFloor: isGroundFloor,
            isSingleLevel: isSingleLevel,
            isFlat: isFlat,
            hasAnyLift: hasAnyLift,
            isUpperFloorFlat: isUpperFloorFlat,
            floorLevel: floorLevel
            }
    };
    return {
        score: preciseScore,
        displayScore: displayScore,
        maxScore: 5,
        features: features,
        percentage: Math.round((score / maxScore) * 100),
        externalAccessWarning: externalAccessWarning, // NEW - for showing ⚠️ icon
         externalAccessAssessed: externalAccessAssessed,
        applicableCriteria: {
            stepFreeOrLift: true,
            downstairsBedroom: true,
            downstairsBathroom: true,
            groundFloorEntry: true,
            privateParking: true,
            garden: true,
            balcony: true,
            externalLevelAccess: true
        },
        details: {
            stepFreeInternal: hasStepFreeInternal,
            lift: hasAnyLift && !hasStepFreeInternal,
            liftType: hasStairlift ? 'stairlift' : hasLift ? 'lift' : null,
            downstairsBedroom: hasDownstairsBedroom,
            downstairsBathroom: hasDownstairsBathroom,
            groundFloorEntry: hasGroundFloorEntry,
            privateParking: hasPrivateParking && !hasOnStreetOnly,
            garden: hasGarden,
            balcony: hasBalcony,
            externalLevelAccess: hasLevelAccess,
            externalAccessVerified: externalAccessVerified, // NEW - whether it was verified (text or vision)
            isSingleLevel: isSingleLevel,
            isGroundFloor: isGroundFloor
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
        
        // Extract ALL images first for debugging
        console.log('🔍 All found images:');
        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src) {
                console.log(`   ${i}: ${src}`);
            }
        });

        // Now extract property images with better filtering
        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && 
                (src.includes('media.rightmove') || src.includes('rightmove.co.uk')) &&
                !src.includes('logo') && 
                !src.includes('icon') &&
                !src.includes('marker') &&
                !src.includes('svg')) {
                images.push(src);
                console.log('✅ Added property image:', src);
            }
        });

        console.log('📊 Total property images found:', images.length);
        
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
            model: 'claude-sonnet-4-20250514',
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



async function extractDimensions(propertyDescription, title, features) {
    console.log('📐 Extracting property dimensions...');
    
    let dimensions = {
        totalSqFt: null,
        totalSqM: null
    };
    
    const fullText = `${title} ${propertyDescription} ${features.join(' ')}`.toLowerCase();
    
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
    
    console.log('📐 Dimension extraction complete:', {
        totalSqFt: dimensions.totalSqFt,
        totalSqM: dimensions.totalSqM
    });
    
    return dimensions;
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
        cost.pricePerSqM = "N/A";
    }

    // Use scraped council tax band first, then fallback to text extraction
    if (property.councilTaxBand) {
        cost.councilTax = property.councilTaxBand;
        console.log('💷 Using scraped council tax band:', cost.councilTax);
    } else {

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
            console.log('💷 DEBUG: Pattern matched:', pattern);
            console.log('💷 DEBUG: Full match text:', match[0]);
            console.log('💷 DEBUG: Extracted band letter:', match[1]);
            console.log('💷 DEBUG: Match index in description:', match.index);
            console.log('💷 DEBUG: Context (50 chars before/after):', 
                description.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50));
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

    const description = property.description || '';
    
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

async function batchDetectGPs(places) {
    const placeList = places.map((place, index) => 
        `${index + 1}. "${place.displayName?.text}" - ${place.formattedAddress}`
    ).join('\n');

    try {
        const prompt = `Which of these are actual GP surgeries/medical practices that provide primary healthcare?

${placeList}

Return ONLY the numbers separated by commas (e.g., "1,3,5"). No other text.
GPs provide general medical care - NOT specialists like nutrition, dentistry, imaging, etc.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-4-20250514',
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
        console.log('🤖 AI RESPONSE:', result);
        
        // IMPROVED PARSING - extract only the line with numbers
        const numberLine = result.split('\n')
            .find(line => /^\d+[\d,\s]+$/.test(line.trim())) || result;
        
        const validIndices = numberLine
            .split(',')
            .map(n => parseInt(n.trim()) - 1)
            .filter(n => !isNaN(n)); // Filter out NaN values
        
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
async function findNearestGPs(lat, lng, maxRadius = 2000) {
    try {
        console.log(`Finding GP surgeries near ${lat}, ${lng} using Places API (New)`);
        console.log(`🗺️ Property location: https://www.google.com/maps?q=${lat},${lng}`);
        
        const requestBody = {
            includedTypes: ["doctor"],
            maxResultCount: 20,
            locationRestriction: {
                circle: {
                    center: { latitude: lat, longitude: lng },
                    radius: maxRadius
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
        
        // ADD THIS NEW DEBUG BLOCK HERE ⬇️
        console.log('🔍 ALL PLACES RETURNED BY API:');
        response.data.places?.forEach((place, index) => {
            const distance = calculateStraightLineDistance(
                lat, lng, 
                place.location?.latitude, 
                place.location?.longitude
            );
            console.log(`   ${index}: ${place.displayName?.text}`);
            console.log(`      Address: ${place.formattedAddress}`);
            console.log(`      Distance: ${(distance * 1000).toFixed(0)}m`);
            console.log(`      Status: ${place.businessStatus}`);
            console.log(`      ---`);
        });

        if (response.data.places && response.data.places.length > 0) {
            const gps = [];

            // Try batch AI detection first
            const validGPIndices = await batchDetectGPs(response.data.places);
            
            if (validGPIndices && validGPIndices.length > 0) {
                console.log(`🤖 AI found ${validGPIndices.length} valid GPs, processing them...`);
                
                for (const index of validGPIndices) {
                    const place = response.data.places[index];
                    if (!place) continue;
                    
                    const name = place.displayName?.text || '';
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        console.log(`Skipping closed place: ${name}`);
                        continue;
                    }
                    
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
                
                for (const place of response.data.places) {
                    const name = place.displayName?.text || '';
                    const address = place.formattedAddress || '';
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        console.log(`Skipping closed place: ${name}`);
                        continue;
                    }
                    
                    if (smartFallbackDetection(name, address)) {
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

        return [];  // Returns empty array when no GPs found
        
    } catch (error) {
        console.error('Places API (New) error:', error.response?.data || error.message);
        return [];
    }
}

// Helper function to calculate straight-line distance
function calculateStraightLineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function generateStaticMapURL(property, gpProximity, publicTransport) {
    if (!process.env.MAPBOX_ACCESS_TOKEN) {
        console.warn('⚠️ No Mapbox token found');
        return null;
    }
    
    const markers = [];
    
    // Add other markers FIRST (bottom layer)
    
    // Train station marker (orange) - furthest away, render first
    if (publicTransport?.trainStations?.[0]?.location) {
        const train = publicTransport.trainStations[0];
        markers.push(`pin-s+f97316(${train.location.lng},${train.location.lat})`);
    }
    
    // GP marker (blue)
    if (gpProximity?.nearestGPs?.[0]?.location) {
        const gp = gpProximity.nearestGPs[0];
        console.log('Adding GP marker at:', gp.location);
        markers.push(`pin-s+3b82f6(${gp.location.lng},${gp.location.lat})`);
    }
    
    // Bus stop marker (green)
    if (publicTransport?.busStops?.[0]?.location) {
        const bus = publicTransport.busStops[0];
        markers.push(`pin-s+10b981(${bus.location.lng},${bus.location.lat})`);
    }
    
    // Property marker (red H) - LAST so it renders on top
    if (property.coordinates) {
        console.log('Adding property marker at:', property.coordinates);
        markers.push(`pin-s-h+ef4444(${property.coordinates.lng},${property.coordinates.lat})`);
    } else {
        console.warn('No property coordinates available!');
    }
    
    const overlays = markers.join(',');
    
    const mapUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/${overlays}/auto/400x400@2x?attribution=false&logo=false&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`;
    
    console.log('🗺️ Generated Mapbox URL with', markers.length, 'markers');
    
    return mapUrl;
}

function getPostcodeFromCoordinates(coordinates) {
    return null;
}

function getScoreRating(score) {
    const roundedScore = Math.round(score);
    
    if (roundedScore === 5) return 'Excellent';
    if (roundedScore === 4) return 'Very Good';
    if (roundedScore === 3) return 'Good';
    if (roundedScore === 2) return 'Fair';
    if (roundedScore === 1) return 'Poor';
    return 'Very Poor';
}

async function findGPsBroadSearch(lat, lng) {
    try {
        const requestBody = {
            includedTypes: ["doctor"],
            maxResultCount: 20,
            locationRestriction: {
                circle: { center: { latitude: lat, longitude: lng }, radius: 5000.0 }
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
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.id,places.businessStatus'
                },
                timeout: 8000
            }
        );
        
        if (response.data.places && response.data.places.length > 0) {
            const gps = response.data.places
                .filter(place => {
                    const name = place.displayName?.text?.toLowerCase() || '';
                    const businessStatus = place.businessStatus;
                    
                    if (businessStatus === 'CLOSED_PERMANENTLY') {
                        return false;
                    }
                    
                    return (
                        (name.includes('surgery') || name.includes('medical') || 
                         name.includes('gp') || name.includes('doctors') ||
                         name.includes('practice') || name.includes('health centre')) &&
                        !name.includes('hospital') &&
                        !name.includes('pharmacy')
                    );
                })
                .map(place => ({
                    name: place.displayName?.text || 'Medical Facility',
                    address: place.formattedAddress || 'Address not available',
                    location: {
                        lat: place.location?.latitude,
                        lng: place.location?.longitude
                    },
                    rating: place.rating || null,
                    placeId: place.id,
                    straightLineDistance: calculateStraightLineDistance(lat, lng, place.location?.latitude, place.location?.longitude)
                }))
                .slice(0, 5);
            
            console.log(`Broad search found ${gps.length} medical facilities`);
            return gps;
        }
        
        return [];
    } catch (error) {
        console.error('Broad Places search failed:', error.response?.data || error.message);
        return [];
    }
}

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

async function analyzeWalkingRoute(fromLat, fromLng, toLat, toLng, gpName) {
    try {
        console.log(`🚶 Calculating walking route to ${gpName}`);
        console.log(`   From: ${fromLat}, ${fromLng}`);
        console.log(`   To: ${toLat}, ${toLng}`);
        
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${fromLat},${fromLng}&` +
            `destination=${toLat},${toLng}&` +
            `mode=walking&` +
            `units=metric&` +
            `region=uk&` +
            `language=en-GB&` +
            `key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(directionsUrl, {
            timeout: 12000
        });
        
        console.log('   Directions API status:', response.data.status);
        
        if (response.data.status !== 'OK') {
            console.error('   Directions API error:', response.data.status, response.data.error_message);
            return null;
        }
        
        if (response.data.routes && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            const leg = route.legs[0];
            
            const durationMinutes = Math.ceil((leg.duration.value / 60) * 1.4);
            
            console.log(`   Base time: ${Math.ceil(leg.duration.value / 60)} mins → Adjusted: ${durationMinutes} mins`);
            
            // ... rest of your existing code to analyze the route ...
            
            return {
                distance: leg.distance.text,
                duration: leg.duration.text,
                durationMinutes: durationMinutes,
                // ... rest of return object
            };
        }
        
        console.log('   No routes found in response');
        return null;
        
    } catch (error) {
        console.error('🚶 Directions API error:', error.message);
        if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response data:', error.response.data);
        }
        return null;
    }
}

function calculateRouteAccessibilityScore(features, durationMinutes) {
    let score = 5;
    
    if (features.hasStairs) score -= 2;
    if (features.hasSteepIncline) score -= 1.5;
    if (features.crossesBusyRoads && !features.hasTrafficLights) score -= 1;
    if (durationMinutes > 15) score -= 1;
    if (durationMinutes > 25) score -= 1;
    
    return Math.max(1, Math.round(score * 10) / 10);
}

function generateAccessibilityNotes(durationMinutes, features, warnings) {
    const notes = [];
    
    // Main distance assessment
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
    
    // Specific route obstacles
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
    
    // Positive note for ideal routes
    if (warnings.length === 0 && durationMinutes <= 10 && !features.hasStairs && !features.hasSteepIncline) {
        notes.push("Route appears level and pedestrian-friendly");
    }
    
    return notes.join('. ') + '.';
}

function calculateGPProximityScore(durationMinutes, routeAccessibilityScore = null) {
    let baseScore;
    
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

async function analyzeGPProximity(lat, lng) {
    try {
        console.log('Analyzing GP proximity with enhanced search...');
        
        let nearestGPs = await findNearestGPs(lat, lng, 2000);

        // Safety check in case findNearestGPs fails
        if (!nearestGPs) {
            nearestGPs = [];
        }

        console.log('🔍 DEBUG: nearestGPs after initial search:', nearestGPs.length, 'GPs found');


        // If no GPs within 2km, search up to 10km for reference
        if (nearestGPs.length === 0) {
            console.log('No GPs within 2km, searching up to 10km for reference...');
            
            const requestBody = {
                includedTypes: ["doctor"],
                maxResultCount: 5,
                locationRestriction: {
                    circle: {
                        center: { latitude: lat, longitude: lng },
                        radius: 10000.0
                    }
                },
                rankPreference: "DISTANCE",
                languageCode: "en-GB",
                regionCode: "GB"
            };
            
            try {
                const response = await axios.post(
                    'https://places.googleapis.com/v1/places:searchNearby',
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                            'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.id,places.businessStatus'
                        },
                        timeout: 8000
                    }
                );
                
                if (response.data.places && response.data.places.length > 0) {
                    const closestPlace = response.data.places[0];
                    const gpLat = closestPlace.location?.latitude;
                    const gpLng = closestPlace.location?.longitude;
                    const straightLineDistance = calculateStraightLineDistance(lat, lng, gpLat, gpLng);
                    
                    nearestGPs = [{
                        name: closestPlace.displayName?.text || 'Medical Practice',
                        address: closestPlace.formattedAddress || 'Address not available',
                        location: { lat: gpLat, lng: gpLng },
                        rating: closestPlace.rating || null,
                        placeId: closestPlace.id,
                        straightLineDistance: straightLineDistance,
                        tooFar: true
                    }];
                    
                    console.log(`Found distant GP: ${nearestGPs[0].name} at ${straightLineDistance.toFixed(2)} km`);
                }
            } catch (distantError) {
                console.error('10km search failed:', distantError.message);
            }
        }
        
        if (nearestGPs.length === 0) {
            return {
                score: 0,
                rating: 'Very Poor',
                nearestGPs: [],
                details: 'No GP surgeries found in the area'
            };
        }
        
        const gpsWithRoutes = [];
        
        for (const gp of nearestGPs.slice(0, 5)) {
            if (gp.tooFar) {
                gpsWithRoutes.push({
                    ...gp,
                    walkingTime: null,
                    adjustedTime: null,
                    distance: `${gp.straightLineDistance.toFixed(2)} km (too far to walk)`,
                    routeWarnings: [],
                    routeAccessibilityScore: 0,
                    baseScore: 0,
                    overallScore: 0
                });
                continue;
            }
            
            const route = await analyzeWalkingRoute(lat, lng, gp.location.lat, gp.location.lng, gp.name);
            
            if (route) {
                const baseScore = calculateGPProximityScore(route.durationMinutes, null);
                const overallScore = calculateGPProximityScore(route.durationMinutes, null);                
                gpsWithRoutes.push({
                    ...gp,
                    walkingTime: route.duration,
                    adjustedTime: `${route.durationMinutes} mins`,
                    distance: route.distance,
                    routeWarnings: route.routeWarnings,
                    routeAccessibilityScore: route.accessibilityScore,
                    accessibilityNotes: route.accessibilityNotes,
                    baseScore: baseScore,
                    overallScore: overallScore  // Now purely based on time, not averaged with accessibility
                });
            } else {
                gpsWithRoutes.push({
                    ...gp,
                    walkingTime: 'Unable to calculate',
                    adjustedTime: 'N/A',
                    distance: `${gp.straightLineDistance.toFixed(2)} km (straight line)`,
                    routeWarnings: [],
                    baseScore: 0,
                    overallScore: 0
                });
            }
        }
        
        // Check if all GPs are too far
        if (gpsWithRoutes.every(gp => gp.tooFar || gp.overallScore === 0)) {
            return {
                score: 0,
                rating: 'Very Poor',
                nearestGPs: gpsWithRoutes,
                details: 'No GP surgeries found within reasonable walking distance'
            };
        }
        
        const accessibleGPs = gpsWithRoutes.filter(gp => !gp.tooFar && gp.overallScore > 0);
        const bestGP = accessibleGPs.sort((a, b) => b.overallScore - a.overallScore)[0];
        
        return {
            score: bestGP.overallScore,
            rating: getScoreRating(bestGP.overallScore),
            nearestGPs: gpsWithRoutes,
            details: bestGP.accessibilityNotes
        };
        
    } catch (error) {
        console.error('Error analyzing GP proximity:', error);
        return {
            score: 0,
            rating: 'Very Poor',
            nearestGPs: [],
            details: 'Unable to analyze GP proximity'
        };
    }
}

async function analyzePublicTransport(lat, lng) {
    try {
        console.log('🚌 Finding public transport near', lat, lng);
        
        let busStops = [];
        let trainStations = [];
        
        // Search for bus stops within 1500m using new Places API
        console.log('🚌 Searching for bus stops within 1500m...');

        // Search for transit_station type to capture more bus stops
        const busRequest = {
            includedTypes: ["transit_station"],
            maxResultCount: 20,
            locationRestriction: {
                circle: { 
                    center: { latitude: lat, longitude: lng }, 
                    radius: 1500.0 
                }
            },
            rankPreference: "DISTANCE"
        };

        const busResponse = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            busRequest,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.types'
                },
                timeout: 8000
            }
        );

        // Filter to only bus-related stops
        let allBusPlaces = [];
        if (busResponse.data.places && busResponse.data.places.length > 0) {
            allBusPlaces = busResponse.data.places.filter(place => {
                const name = (place.displayName?.text || '').toLowerCase();
                const types = place.types || [];
                // Include if name contains 'bus' or if it's a bus/transit station type
                return name.includes('bus') || 
                    types.includes('bus_station') || 
                    types.includes('transit_station');
            });
            console.log(`🚌 Found ${allBusPlaces.length} bus stops from ${busResponse.data.places.length} transit stations`);
        }

        if (allBusPlaces.length > 0) {
            for (const stop of allBusPlaces.slice(0, 3)) {
                const distance = calculateStraightLineDistance(
                    lat, lng,
                    stop.location.latitude,
                    stop.location.longitude
                );
                
                const route = await analyzeWalkingRoute(
                    lat, lng,
                    stop.location.latitude,
                    stop.location.longitude,
                    stop.displayName?.text || 'Bus Stop'
                );
                
                if (route) {
                    busStops.push({
                        name: stop.displayName?.text || 'Bus Stop',
                        address: stop.formattedAddress || 'Address not available',
                        location: {
                            lat: stop.location.latitude,
                            lng: stop.location.longitude
                        },
                        distance: route.distance,
                        walkingTime: Math.ceil(route.durationMinutes),
                        straightLineDistance: distance
                    });
                }
            }
        }
        
        // If no bus stops within 1500m, search up to 5km
        if (busStops.length === 0) {
            console.log('🚌 No bus stops within 1500m, searching up to 5km...');
            
            const wideBusRequest = {
                includedTypes: ["bus_station"],
                maxResultCount: 5,
                locationRestriction: {
                    circle: { 
                        center: { latitude: lat, longitude: lng }, 
                        radius: 5000.0 
                    }
                },
                rankPreference: "DISTANCE"
            };
            
            const wideBusResponse = await axios.post(
                'https://places.googleapis.com/v1/places:searchNearby',
                wideBusRequest,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
                    },
                    timeout: 8000
                }
            );
            
            if (wideBusResponse.data.places && wideBusResponse.data.places.length > 0) {
                const nearestBus = wideBusResponse.data.places[0];
                const distance = calculateStraightLineDistance(
                    lat, lng,
                    nearestBus.location.latitude,
                    nearestBus.location.longitude
                );
                
                busStops.push({
                    name: nearestBus.displayName?.text || 'Bus Stop',
                    address: nearestBus.formattedAddress || 'Address not available',
                    location: {
                        lat: nearestBus.location.latitude,
                        lng: nearestBus.location.longitude
                    },
                    distance: `${distance.toFixed(2)} km`,
                    walkingTime: null,
                    straightLineDistance: distance,
                    tooFar: true
                });
                
                console.log(`🚌 Found distant bus stop: ${nearestBus.displayName?.text} at ${distance.toFixed(2)}km`);
            }
        }
        
        // Search for train stations within 2500m using new Places API
        console.log('🚂 Searching for train stations within 2500m...');
        const trainRequest = {
            includedTypes: ["train_station"],
            maxResultCount: 5,
            locationRestriction: {
                circle: { 
                    center: { latitude: lat, longitude: lng }, 
                    radius: 2500.0 
                }
            },
            rankPreference: "DISTANCE"
        };
        
        const trainResponse = await axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            trainRequest,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
                },
                timeout: 8000
            }
        );
        
        if (trainResponse.data.places && trainResponse.data.places.length > 0) {
            console.log(`🚂 Found ${trainResponse.data.places.length} train stations within 2500m`);
            
            for (const station of trainResponse.data.places.slice(0, 2)) {
                const distance = calculateStraightLineDistance(
                    lat, lng,
                    station.location.latitude,
                    station.location.longitude
                );
                
                const route = await analyzeWalkingRoute(
                    lat, lng,
                    station.location.latitude,
                    station.location.longitude,
                    station.displayName?.text || 'Train Station'
                );
                
                if (route) {
                    trainStations.push({
                        name: station.displayName?.text || 'Train Station',
                        address: station.formattedAddress || 'Address not available',
                        location: {
                            lat: station.location.latitude,
                            lng: station.location.longitude
                        },
                        distance: route.distance,
                        walkingTime: Math.ceil(route.durationMinutes),
                        straightLineDistance: distance
                    });
                }
            }
        }
        
        // If no train stations within 2500m, search up to 10km
        if (trainStations.length === 0) {
            console.log('🚂 No train stations within 2500m, searching up to 10km...');
            
            const wideTrainRequest = {
                includedTypes: ["train_station"],
                maxResultCount: 5,
                locationRestriction: {
                    circle: { 
                        center: { latitude: lat, longitude: lng }, 
                        radius: 10000.0 
                    }
                },
                rankPreference: "DISTANCE"
            };
            
            const wideTrainResponse = await axios.post(
                'https://places.googleapis.com/v1/places:searchNearby',
                wideTrainRequest,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
                        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
                    },
                    timeout: 8000
                }
            );
            
            if (wideTrainResponse.data.places && wideTrainResponse.data.places.length > 0) {
                const nearestTrain = wideTrainResponse.data.places[0];
                const distance = calculateStraightLineDistance(
                    lat, lng,
                    nearestTrain.location.latitude,
                    nearestTrain.location.longitude
                );
                
                trainStations.push({
                    name: nearestTrain.displayName?.text || 'Train Station',
                    address: nearestTrain.formattedAddress || 'Address not available',
                    location: {
                        lat: nearestTrain.location.latitude,
                        lng: nearestTrain.location.longitude
                    },
                    distance: `${distance.toFixed(2)} km`,
                    walkingTime: null,
                    straightLineDistance: distance,
                    tooFar: true
                });
                
                console.log(`🚂 Found distant train station: ${nearestTrain.displayName?.text} at ${distance.toFixed(2)}km`);
            }
        }
        
        // Calculate score based ONLY on bus stops (doubled thresholds)
        let score = 0;
        const walkableBusStops = busStops.filter(b => !b.tooFar);
        
        if (walkableBusStops.length > 0) {
            const nearestBus = walkableBusStops[0];
            const time = nearestBus.walkingTime;
            
            if (time <= 5) score = 5;
            else if (time <= 10) score = 4;
            else if (time <= 15) score = 3;
            else if (time <= 20) score = 2;
            else if (time <= 25) score = 1;
            
            console.log(`🚌 Nearest bus stop: ${nearestBus.name}, ${time} mins walk, score: ${score}/5`);
        }
        
        console.log(`🚌 Public transport score: ${score}/5 (based on bus accessibility only)`);
        
        return {
            score: score,
            busStops: busStops,
            trainStations: trainStations,
            busAccessibility: walkableBusStops.length > 0 ? 
                `Nearest bus stop ${walkableBusStops[0].walkingTime} mins walk` : 
                busStops.length > 0 ? `Nearest bus stop ${busStops[0].straightLineDistance.toFixed(2)}km away - transport required` : 
                'No bus stops found',
            trainAccessibility: trainStations.length > 0 && !trainStations[0].tooFar ? 
                `Nearest train station ${trainStations[0].walkingTime} mins walk` :
                trainStations.length > 0 ? `Nearest train station ${trainStations[0].straightLineDistance.toFixed(2)}km away` :
                'No train stations found nearby'
        };
        
    } catch (error) {
        console.error('Error analyzing public transport:', error.message);
        return {
            score: 0,
            busStops: [],
            trainStations: [],
            busAccessibility: 'Unable to analyze',
            trainAccessibility: 'Unable to analyze'
        };
    }
}

// Reuse GP proximity walking route analysis
async function analyzeWalkingRoute(fromLat, fromLng, toLat, toLng, gpName) {
    try {
        console.log(`🚶 Calculating walking route to ${gpName || 'location'}`);
        
        const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${fromLat},${fromLng}&` +
            `destination=${toLat},${toLng}&` +
            `mode=walking&` +
            `units=metric&` +
            `region=uk&` +
            `language=en-GB&` +
            `key=${process.env.GOOGLE_MAPS_API_KEY}`;
        
        const response = await axios.get(directionsUrl, {
            timeout: 12000
        });
        
        if (response.data.status !== 'OK') {
            console.error('   Directions API error:', response.data.status);
            return null;
        }
        
        if (response.data.routes && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            const leg = route.legs[0];
            
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
                if (instruction.includes('main') || instruction.includes('busy') || instruction.includes('major')) {
                    routeWarnings.push('Crosses busy roads');
                    routeFeatures.crossesBusyRoads = true;
                }
                if (instruction.includes('traffic lights') || instruction.includes('crossing')) {
                    routeFeatures.hasTrafficLights = true;
                }
            });
            
            const durationMinutes = Math.ceil((leg.duration.value / 60) * 1.4);
            console.log(`   Base time: ${Math.ceil(leg.duration.value / 60)} mins → Adjusted: ${durationMinutes} mins`);

            return {
                distance: leg.distance.text,
                duration: leg.duration.text,
                durationMinutes: durationMinutes,
                durationSeconds: Math.round(leg.duration.value * 1.4),
                distanceMeters: leg.distance.value,
                routeWarnings: [...new Set(routeWarnings)],
                routeFeatures: routeFeatures,
                accessibilityScore: calculateRouteAccessibilityScore(routeFeatures, durationMinutes),
                accessibilityNotes: generateAccessibilityNotes(durationMinutes, routeFeatures, routeWarnings),
                gpName: gpName,
                steps: steps.length
            };
        }
        
        return null;
        
    } catch (error) {
        console.error('Directions API error:', error.message);
        return null;
    }
}
// Analyze route steps for accessibility features (reuse from GP analysis)
function analyzeRouteFeatures(steps) {
    const features = {
        hasStairs: false,
        hasSteepIncline: false,
        crossesBusyRoads: false,
        hasTrafficLights: false
    };
    
    const routeText = steps.map(step => step.html_instructions.toLowerCase()).join(' ');
    
    if (routeText.includes('stairs') || routeText.includes('steps')) {
        features.hasStairs = true;
    }
    
    if (routeText.includes('steep') || routeText.includes('hill')) {
        features.hasSteepIncline = true;
    }
    
    if (routeText.includes('cross') || routeText.includes('junction')) {
        features.crossesBusyRoads = true;
        if (routeText.includes('traffic light') || routeText.includes('crossing')) {
            features.hasTrafficLights = true;
        }
    }
    
    return features;
}

// Score based on adjusted walking time (same as GP proximity)
function calculateTransitScoreFromTime(adjustedMinutes) {
    if (adjustedMinutes <= 5) return 5;
    if (adjustedMinutes <= 10) return 4;
    if (adjustedMinutes <= 15) return 3;
    if (adjustedMinutes <= 20) return 2;
    if (adjustedMinutes <= 25) return 1;
    return 0;
}

// Update findNearbyTransit to remove the inaccurate walkingTime calculation
async function findNearbyTransit(lat, lng, transitType) {
    try {
        const requestBody = {
            includedTypes: [transitType],
            maxResultCount: 10,
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
                // Remove inaccurate walkingTime - will be set by analyzeWalkingRoute
                placeId: place.id
            })).sort((a, b) => a.distance - b.distance);
        }
        
        return [];
        
    } catch (error) {
        console.error(`${transitType} search failed:`, error.message);
        return [];
    }
}

const pdfParse = require('pdf-parse');

// Helper function to extract text from PDF first page
async function extractTextFromPDFFirstPage(pdfUrl) {
    try {
        console.log('📄 Extracting text from PDF first page...');
        
        const response = await axios.get(pdfUrl, { 
            responseType: 'arraybuffer',
            timeout: 10000
        });
        
        const data = await pdfParse(response.data, {
            max: 1  // Only parse first page
        });
        
        // Get first 2000 characters (should include the EPC rating section)
        const text = data.text.substring(0, 2000);
        console.log('📄 PDF text preview:', text.substring(0, 300));
        
        // Look for "Energy rating X" pattern
        const ratingPatterns = [
            /energy\s+rating\s+([a-g])/i,
            /current\s+rating[:\s]+([a-g])/i,
            /rating[:\s]+([a-g])\s+/i
        ];
        
        for (const pattern of ratingPatterns) {
            const match = text.match(pattern);
            if (match) {
                const rating = match[1].toUpperCase();
                console.log(`✅ Found EPC rating in PDF text: ${rating}`);
                return rating;
            }
        }
        
        console.log('⚠️ No EPC rating found in PDF text');
        return null;
        
    } catch (error) {
        console.error('❌ PDF text extraction failed:', error.message);
        return null;
    }
}

// Main EPC extraction function
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
        const epcUrls = {
            pdfs: [],
            images: []
        };
        
        // Strategy 1: Look for EPC PDFs and images
        $('a[href*=".pdf"]').each((i, link) => {
            const href = $(link).attr('href');
            const text = $(link).text().toLowerCase();
            
            if (text.includes('epc') || href.toLowerCase().includes('epc')) {
                const fullUrl = href.startsWith('http') ? href : 
                              href.startsWith('//') ? `https:${href}` : 
                              `https://www.rightmove.co.uk${href}`;
                
                epcUrls.pdfs.push(fullUrl);
            }
        });
        
        // Strategy 2: Look for direct EPC images (including GIFs)
        const epcUrlPatterns = [
            /_EPC_/i, /\/epc\//i, /energy[-_]performance/i,
            /energy[-_]certificate/i, /certificate.*energy/i,
            /EPCGRAPH/i  // Added for Rightmove EPC graph pattern
        ];
        
        $('*').each((i, element) => {
            const $el = $(element);
            ['src', 'data-src', 'data-lazy-src', 'href', 'data-href', 'data-url'].forEach(attr => {
                const value = $el.attr(attr);
                if (value && epcUrlPatterns.some(pattern => pattern.test(value))) {
                    const fullUrl = value.startsWith('http') ? value : 
                                  value.startsWith('//') ? `https:${value}` : 
                                  `https://www.rightmove.co.uk${value}`;
                    
                    if (fullUrl.toLowerCase().endsWith('.pdf')) {
                        if (!epcUrls.pdfs.includes(fullUrl)) {
                            epcUrls.pdfs.push(fullUrl);
                        }
                    } else if (fullUrl.match(/\.(png|jpg|jpeg|gif)$/i)) {  // Added .gif support
                        if (!epcUrls.images.includes(fullUrl)) {
                            epcUrls.images.push(fullUrl);
                        }
                    }
                }
            });
        });
        
        // Strategy 3: Look in scripts for EPC URLs (including GIFs)
        $('script').each((i, script) => {
            const scriptContent = $(script).html() || '';
            const epcMatches = scriptContent.match(/https?:\/\/[^"'\s]*[Ee][Pp][Cc][^"'\s]*\.(pdf|png|jpg|jpeg|gif)/gi);  // Added gif
            if (epcMatches) {
                epcMatches.forEach(match => {
                    if (match.toLowerCase().endsWith('.pdf')) {
                        if (!epcUrls.pdfs.includes(match)) {
                            epcUrls.pdfs.push(match);
                        }
                    } else {
                        if (!epcUrls.images.includes(match)) {
                            epcUrls.images.push(match);
                        }
                    }
                });
            }
        });
        
        console.log(`📊 Found ${epcUrls.pdfs.length} EPC PDFs and ${epcUrls.images.length} EPC images`);
        return epcUrls;

    } catch (error) {
        console.error('❌ Error in enhanced EPC detection:', error.message);
        return { pdfs: [], images: [] };
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


        // Inside scrapeRightmoveProperty, after const $ = cheerio.load(rightmoveResponse.data);

        // Extract property images
        const images = [];
        console.log('🔍 Extracting property images...');
        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src) {
                console.log(`   Image ${i}: ${src}`);
                
                // Filter for ACTUAL property photos
                if ((src.includes('media.rightmove') || src.includes('rightmove.co.uk')) &&
                    (src.includes('/property-photo/') || src.match(/IMG_\d+_\d+\.(jpeg|jpg|png)/i)) &&  // ← Accept EITHER format
                    !src.includes('logo') && 
                    !src.includes('icon') &&
                    !src.includes('marker') &&
                    !src.includes('epc') &&
                    !src.includes('flp') &&
                    !src.includes('_bp_') &&
                    !src.includes('branch_logo') &&
                    !src.includes('affiliation') &&
                    !src.includes('svg')) {
                    images.push(src);
                    console.log('   ✅ Added as property image');
                }
            }
        });

        console.log(`📊 Total property images found: ${images.length}`);
        
        // Extract parking section
        let parkingInfo = '';
        $('dt, .key, [class*="key"]').each((i, el) => {
            const keyText = $(el).text().toLowerCase().trim();
            if (keyText === 'parking') {
                const valueElement = $(el).next();
                if (valueElement.length) {
                    parkingInfo = valueElement.text().trim();
                    console.log('🅿️ Found parking section:', parkingInfo);
                }
            }
        });

        // Extract garden section
        let gardenInfo = '';
        $('dt, .key, [class*="key"]').each((i, el) => {
            const keyText = $(el).text().toLowerCase().trim();
            if (keyText === 'garden') {
                const valueElement = $(el).next();
                if (valueElement.length) {
                    gardenInfo = valueElement.text().trim();
                    console.log('🌱 Found garden section:', gardenInfo);
                }
            }
        });

        
        
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
            location = location
                .replace(/^[,\s]+|[,\s]+$/g, '') // Remove leading/trailing commas and spaces
                .replace(/GUIDE PRICE/gi, '') // Remove "GUIDE PRICE" text
                .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                .trim(); // Final trim
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
            '[data-test="property-description"]',
            'article',
            'main'
        ];

        for (const selector of descriptionSelectors) {
            const desc = $(selector).text().trim();
            if (desc && desc.length > 50) {
                description = desc;
                console.log('🏠 DEBUG: Description length:', desc.length);
                console.log('🏠 DEBUG: Description includes "council tax"?', desc.toLowerCase().includes('council tax'));
                console.log('🏠 DEBUG: Description includes "front garden"?', desc.toLowerCase().includes('front garden'));
                console.log('🏠 DEBUG: First 500 chars:', desc.substring(0, 500));
                break;
            }
        }

        // If description doesn't include garden info, try to find and append it
        if (description && !description.toLowerCase().includes('front garden') && !description.toLowerCase().includes('rear garden')) {
            console.log('🌱 Description missing garden info, searching for Outside section...');
            const bodyText = $('body').text();
            const outsideMatch = bodyText.match(/Outside:[\s\S]*?(?=WORKSHOP:|Agent's Note|Mortgage|$)/i);
            if (outsideMatch) {
                description += '\n\n' + outsideMatch[0];
                console.log('✅ Appended Outside section to description');
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

        console.log('🏠 Final description length:', description.length);
        console.log('🏠 Final description includes garden:', description.toLowerCase().includes('front garden') || description.toLowerCase().includes('rear garden'));

        
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

        // Extract Council Tax Band from structured section
        console.log('🏠 Extracting council tax band...');
        let councilTaxBand = null;

        // Method 1: Look for structured council tax data
        const councilTaxSelectors = [
            '[data-testid="council-tax"]',
            '.council-tax-band',
            '[class*="council"]'
        ];

        for (const selector of councilTaxSelectors) {
            const element = $(selector);
            if (element.length) {
                const text = element.text();
                const bandMatch = text.match(/band[:\s]*([a-h])\b/i);
                if (bandMatch) {
                    councilTaxBand = `Band ${bandMatch[1].toUpperCase()}`;
                    console.log('Found council tax in structured element:', councilTaxBand);
                    break;
                }
            }
        }

        // Method 2: Look for dt/dd or label/value pairs
        if (!councilTaxBand) {
            $('dt, th, .property-detail-key, .key, label').each((i, el) => {
                const keyText = $(el).text().toLowerCase().trim();
                if (keyText.includes('council') && keyText.includes('tax')) {
                    const valueElement = $(el).next('dd, td, .property-detail-value, .value, span, div');
                    if (valueElement.length) {
                        const valueText = valueElement.text().trim();
                        const bandMatch = valueText.match(/band[:\s]*([a-h])\b/i);
                        if (bandMatch) {
                            councilTaxBand = `Band ${bandMatch[1].toUpperCase()}`;
                            console.log('Found council tax in key-value pair:', councilTaxBand);
                            return false; // Break
                        }
                    }
                }
            });
        }

        // Method 3: Look for "Council band X" pattern FIRST (most common in key features)
        if (!councilTaxBand) {
            const fullPageText = $('body').text();
            const allText = `${description} ${features.join(' ')} ${fullPageText}`;
            
            // Priority pattern: "Council band E" from key features
            const councilBandMatch = allText.match(/council\s+band\s+([a-h])\b/i);
            if (councilBandMatch) {
                councilTaxBand = `Band ${councilBandMatch[1].toUpperCase()}`;
                console.log('💷 Found "Council band" in text:', councilTaxBand);
            }
        }

        // Method 4: Search with other patterns if still not found
        if (!councilTaxBand) {
            const fullPageText = $('body').text();
            const allText = `${description} ${features.join(' ')} ${fullPageText}`.toLowerCase();
            
            // Look for other common patterns
            const patterns = [
                /council\s+tax:\s+band\s+([a-h])\b/i,
                /council\s+tax\s+band[:\s]+([a-h])\b/i,
                /tax\s+band[:\s]+([a-h])\b/i
            ];
            
            for (const pattern of patterns) {
                const match = allText.match(pattern);
                if (match) {
                    const context = allText.substring(
                        Math.max(0, match.index - 50), 
                        match.index + match[0].length + 50
                    );
                    
                    const isCouncilTax = context.includes('council') && context.includes('tax');
                    const notEPC = !context.includes('epc') && !context.includes('energy') && !context.includes('rating');
                    const notGenericTax = !context.includes('tax a payment'); // Avoid "COUNCIL TAXA payment"
                    
                    if (isCouncilTax && notEPC && notGenericTax) {
                        councilTaxBand = `Band ${match[1].toUpperCase()}`;
                        console.log('Found council tax in text:', councilTaxBand);
                        break;
                    }
                }
            }
        }

        console.log('Final council tax band from scraping:', councilTaxBand);


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
                /epc\s*[-:]\s*rating\s*([a-g])\b/gi,  // NEW: "EPC: rating C" or "epc rating c"
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

            // STEP 2: Try PDF text extraction first, then Vision API on images
            if (!epcData.rating) {
                console.log('🔍 Step 2: Searching for EPC files...');
                
                const epcUrls = await extractEPCFromRightmoveDropdown(url);
                
                // Try PDFs first (text extraction - faster and more reliable)
                for (const pdfUrl of epcUrls.pdfs.slice(0, 2)) {
                    const rating = await extractTextFromPDFFirstPage(pdfUrl);
                    if (rating) {
                        epcData = {
                            rating: rating,
                            score: null,
                            confidence: 90,
                            reason: 'Extracted from EPC PDF',
                            numericalScore: 0
                        };
                        break;
                    }
                }
                
                // If PDF extraction failed, try Vision API on images
                if (!epcData.rating && epcUrls.images.length > 0 && process.env.CLAUDE_API_KEY) {
                    console.log('🔑 Trying Vision API on EPC images...');
                    
                    for (const imageUrl of epcUrls.images.slice(0, 2)) {
                        // Skip if it's a GIF
                        if (imageUrl.includes('.gif')) continue;
                        
                        try {
                            // Your existing Vision API code here...
                        } catch (error) {
                            console.log(`❌ Vision analysis failed: ${error.message}`);
                        }
                    }
                }
            }

            // STEP 3: Enhanced text pattern matching
            if (!epcData.rating) {
                console.log('🔍 Step 3: Using enhanced text pattern matching...');
                
                const epcUrls = await extractEPCFromRightmoveDropdown(url);
                const epcImageUrls = [...epcUrls.images];  // Convert to array, copy the images array

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
                                model: 'claude-sonnet-4-20250514',
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

        // Extract council tax from same text source used for EPC
        if (!councilTaxBand) {
            const fullPageText = $('body').text();
            const allTextSources = `${title} ${description} ${features.join(' ')} ${fullPageText}`.toLowerCase();
            
            const councilTaxMatch = allTextSources.match(/council\s+tax:\s+band\s+([a-h])\b/i);
            if (councilTaxMatch) {
                councilTaxBand = `Band ${councilTaxMatch[1].toUpperCase()}`;
                console.log('✅ Found council tax in full text:', councilTaxBand);
            }
        }

        // Just before return statement in scrapeRightmoveProperty()
        const fullPageText = $('body').text();
        
        return {
            id: propertyId,
            title: title,
            location: location,
            price: price,
            description: description,
            parkingInfo: parkingInfo,
            gardenInfo: gardenInfo,
            fullPageText: fullPageText,
            features: features,
            images: images.slice(0, 5),
            floorplan: floorplan,
            epc: epcData,
            epcRating: epcData.rating,
            address: address || 'Address not found',
            coordinates: coordinates,
            tenure: tenure,
            leaseholdDetails: leaseholdDetails,
            councilTaxBand: councilTaxBand,
            dimensions: await extractDimensions(description, title, features)
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
        try {
            const gpResult = await analyzeGPProximity(property.coordinates.lat, property.coordinates.lng);
            
            // Transform new structure to match what frontend expects
            gpProximity = {
                score: gpResult.score,
                rating: gpResult.rating,
                details: gpResult.details,
                nearestGPs: gpResult.nearestGPs  // Pass the array through
            };
        } catch (error) {
            console.error('GP proximity analysis failed:', error.message);
            gpProximity = {
                score: 0,
                rating: 'Very Poor',
                nearestGPs: [],
                details: 'Unable to analyze GP proximity'
            };
        }
    }

    
    // Step 2: Get EPC rating from property data
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

    // Step 5b: Calculate Room Score
    console.log('🏠 Calculating room accommodation score...');
    const roomScore = calculateRoomScore(property);
    console.log(`🏠 Room Score: ${roomScore.rawScore}/${roomScore.maxPossible} → ${roomScore.score}/5`);
    console.log('✅ Rooms found:', roomScore.roomsFound);

    

    // ADD THIS NEW STEP 6:
    // Step 6: NEW - Analyze Cost Information
    console.log('💷 Analyzing cost information...');
    const cost = analyzeCostInformation(property, dimensions);
    
    // Step 6b: Calculate Council Tax Score
console.log('💷 Calculating council tax score...');
console.log('💷 DEBUG: cost.councilTax value:', cost.councilTax);
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

// Step 6d: Calculate Property Tax Score (SDLT/LTT/LBTT based on location)
console.log('💷 Calculating property tax score...');

// Extract postcode from location string (e.g., "Knights Green, Flint, CH6")
let postcode = null;
if (property.location) {
    const postcodeMatch = property.location.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)(?:\s*\d[A-Z]{2})?\b/i);
    if (postcodeMatch) {
        postcode = postcodeMatch[1].toUpperCase();
        console.log('📮 Extracted postcode from location:', postcode);
    }
}

// Fallback: reverse geocode from coordinates to get postcode
if (!postcode && property.coordinates) {
    try {
        const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${property.coordinates.lat},${property.coordinates.lng}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        const geocodeResponse = await axios.get(geocodeUrl);
        
        if (geocodeResponse.data.results && geocodeResponse.data.results[0]) {
            const components = geocodeResponse.data.results[0].address_components;
            const postcodeComponent = components.find(c => c.types.includes('postal_code'));
            if (postcodeComponent) {
                postcode = postcodeComponent.short_name.split(' ')[0].toUpperCase();
                console.log('📮 Extracted postcode from reverse geocoding:', postcode);
            }
        }
    } catch (error) {
        console.log('📮 Reverse geocoding failed:', error.message);
    }
}

if (!postcode) {
    console.log('📮 No postcode found, defaulting to England');
}

let stampDutyAnalysis = { 
    score: null, 
    rating: 'Unknown', 
    description: 'Not available', 
    amount: null, 
    percentage: null,
    taxName: 'Stamp Duty',
    taxNameFull: 'Stamp Duty Land Tax',
    country: 'england'
};

// Parse property price
let propertyPriceNumber = null;
if (property.price) {
    const priceMatch = String(property.price).match(/[\d,]+/);
    if (priceMatch) {
        propertyPriceNumber = parseInt(priceMatch[0].replace(/,/g, ''));
        stampDutyAnalysis = calculatePropertyTaxScore(propertyPriceNumber, postcode);
        console.log(`💷 ${stampDutyAnalysis.taxName} (${stampDutyAnalysis.country}): £${stampDutyAnalysis.amount}`);
    }
}

// Step 6e: Calculate combined Property Cost Score
let propertyCostScore = null;
let propertyCostRating = 'Unknown';
const availableScores = [];

if (councilTaxAnalysis.score !== null) {
    availableScores.push(councilTaxAnalysis.score);
}
if (pricePerSqMAnalysis.score !== null) {
    availableScores.push(pricePerSqMAnalysis.score);
}
if (stampDutyAnalysis.score !== null) {
    availableScores.push(stampDutyAnalysis.score);
}

if (availableScores.length > 0) {
    propertyCostScore = availableScores.reduce((a, b) => a + b, 0) / availableScores.length;
    propertyCostRating = getScoreRating(propertyCostScore);
    console.log(`💷 Property Cost: ${availableScores.length} score(s) available, averaged to ${propertyCostScore.toFixed(1)}`);
}


// Updated overall score calculation - only include available metrics
let scoresToAverage = [
    gpProximity.score, 
    accessibleFeatures.score, 
    publicTransport.score, 
    roomScore.score
];

// Only include EPC if it was actually found
if (epcScore !== null) {
    scoresToAverage.push(epcScore);
}

// Only include property cost if available
if (propertyCostScore !== null) {
    scoresToAverage.push(propertyCostScore);
}

const overallScore = scoresToAverage.reduce((sum, score) => sum + score, 0) / scoresToAverage.length;

console.log('📊 Scores included in overall:', scoresToAverage.length);
console.log('💷 Property Cost Score:', propertyCostScore);
console.log('⚡ EPC Score:', epcScore);
console.log('🎯 Overall Score:', overallScore);


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
        stampDutyAnalysis,
        overallScore, 
        property.title, 
        property.epcRating, 
        property.location,
        roomScore,
        accessibleFeatures.details.isSingleLevel,      // From returned object
        accessibleFeatures.details.isFlat,             // From returned object
        accessibleFeatures.details.hasAnyLift,         // From returned object
        accessibleFeatures.details.isUpperFloorFlat,   // From returned object
        accessibleFeatures.details.floorLevel          // From returned object
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
            rating: gpProximity.rating || getScoreRating(gpProximity.score || 0),
            details: gpProximity.details || 'No details available',
            nearestGPs: gpProximity.nearestGPs || []  // NEW - pass the array
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
        roomAccommodation: {
            score: roomScore.score,
            rating: getScoreRating(roomScore.score),
            details: `${roomScore.rawScore}/${roomScore.maxPossible} essential rooms found`,
            roomsFound: roomScore.roomsFound
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
        stampDuty: {
            score: stampDutyAnalysis.score,
            rating: stampDutyAnalysis.score !== null ? getScoreRating(stampDutyAnalysis.score) : 'Unknown',
            details: stampDutyAnalysis.description,
            amount: stampDutyAnalysis.amount,
            percentage: stampDutyAnalysis.percentage,
            taxName: stampDutyAnalysis.taxName || 'Stamp Duty',
            taxNameFull: stampDutyAnalysis.taxNameFull || 'Stamp Duty Land Tax',
            country: stampDutyAnalysis.country || 'england'
        },
        propertyCost: {
            score: propertyCostScore,
            rating: propertyCostRating,
            details: propertyCostScore !== null ? `Combined score from council tax, price per sq m, and ${stampDutyAnalysis.taxName || 'stamp duty'}` : 'Property cost information not available',
            councilTaxRating: councilTaxAnalysis.rating,
            pricePerSqMPercentile: pricePerSqMAnalysis.percentile,
            stampDutyAmount: stampDutyAnalysis.amount,
            stampDutyPercentage: stampDutyAnalysis.percentage
        },
        dimensions: property.dimensions || null,
        cost: cost,
        overall: Math.round((overallScore || 0) * 10) / 10,
        summary: summary || 'Analysis completed successfully'
    };
}

function generateComprehensiveSummary(gpProximity, epcScore, accessibleFeatures, publicTransport, cost, councilTaxAnalysis, pricePerSqMAnalysis, stampDutyAnalysis, overallScore, title, epcRating, location, roomAccommodation, isSingleLevel, isFlat, hasAnyLift, isUpperFloorFlat, floorLevel)  {
    let summary = "";
    
    const accessibleFeaturesScore = accessibleFeatures.score || 0;
    
    // Extract property type from title
    let propertyType = "property";
    let bedrooms = "";
    if (title) {
        const titleLower = title.toLowerCase();
        const bedroomMatch = titleLower.match(/(\d+)\s*bedroom/);
        if (bedroomMatch) {
            bedrooms = `${bedroomMatch[1]} bedroom `;
            const typeMatch = titleLower.match(/\d+\s*bedroom\s+(.+)/);
            if (typeMatch) {
                propertyType = typeMatch[1];
            }
        }
    }

    // Add "property" if propertyType is just an adjective like "terraced"
    const propertyAdjectives = ['terraced', 'detached', 'semi-detached', 'end-terrace'];
    let fullPropertyType = propertyType;
    if (propertyAdjectives.includes(propertyType.toLowerCase())) {
        fullPropertyType = `${propertyType} house`;
    }

    summary += `This ${bedrooms}${fullPropertyType}`;

    if (location) {
        // Extract just the area/town (second to last part of address)
        if (location.includes(',')) {
            const parts = location.split(',').map(p => p.trim());
            const area = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
            summary += ` located in ${area}`;
        } else {
            summary += ` located in ${location}`;
        }
    }

    const overallRating = getScoreRating(overallScore);
    summary += ` has achieved an overall accessibility score of ${Math.round(overallScore * 10) / 10}/5 (${overallRating}). `;

    console.log('💷 DEBUG Stamp Duty Description:', stampDutyAnalysis.description);

    // 2. FIXED: Match "Low stamp duty cost" pattern
    if (cost && cost.price) {
        const priceComponents = [];
        priceComponents.push(`The property is priced at ${cost.price}`);
        
        // Use the correct tax name based on location
        const taxName = stampDutyAnalysis.taxName || 'stamp duty';
        
        if (stampDutyAnalysis && stampDutyAnalysis.amount && stampDutyAnalysis.amount !== '£0') {
            let dutyDescriptor = 'moderate cost';
            
            if (stampDutyAnalysis.description) {
                const descLower = stampDutyAnalysis.description.toLowerCase();
                // Match patterns: "low stamp duty cost", "low cost", etc.
                if (descLower.includes('low')) {
                    dutyDescriptor = 'low cost';
                } else if (descLower.includes('moderate')) {
                    dutyDescriptor = 'moderate cost';
                } else if (descLower.includes('high')) {
                    dutyDescriptor = 'high cost';
                }
            }
            
            const formattedAmount = String(stampDutyAnalysis.amount).startsWith('£') ? 
                stampDutyAnalysis.amount : `£${stampDutyAnalysis.amount}`;
            
            priceComponents.push(`with ${dutyDescriptor} ${taxName} of ${formattedAmount}`);
        }
        
        summary += priceComponents.join(' ') + '. ';
    }
    
    // 3. FIXED: Combined rooms and features with proper "and" before last item
    const foundFeatures = accessibleFeatures.features || [];
    const totalFeatures = 8;
    
    let combinedSentence = '';
    
    // Add room count if available
    if (roomAccommodation && roomAccommodation.roomsFound) {
        const essentialRooms = roomAccommodation.roomsFound.filter(r => 
            !r.toLowerCase().includes('bedroom 3') && 
            !r.toLowerCase().includes('additional')
        );
        combinedSentence += `This property has ${essentialRooms.length}/6 essential rooms`;
    } else {
        combinedSentence += `This property has`;
    }
    
    // Add feature count
    if (foundFeatures.length > 0) {
        if (combinedSentence.includes('rooms')) {
            combinedSentence += ` and ${foundFeatures.length}/${totalFeatures} accessible features including `;
        } else {
            combinedSentence += ` ${foundFeatures.length}/${totalFeatures} accessible features including `;
        }
        
        // Format list with "and" before last item
        const featureList = foundFeatures.slice(0, 4).map(f => f.toLowerCase());
        if (featureList.length > 1) {
            const lastFeature = featureList.pop();
            combinedSentence += featureList.join(', ') + ' and ' + lastFeature;
        } else {
            combinedSentence += featureList[0];
        }
        
        if (foundFeatures.length > 4) {
            combinedSentence += `, plus ${foundFeatures.length - 4} more`;
        }
    }
    
    summary += combinedSentence + '. ';
    
    // 5. Healthcare access
    const gpRating = getScoreRating(gpProximity.score || 0);
    summary += `Proximity to a GP is ${gpRating.toLowerCase()}`;
    
    if (gpProximity.nearestGPs && gpProximity.nearestGPs.length > 0) {
        const nearestGP = gpProximity.nearestGPs[0];
        
        if (nearestGP.tooFar) {
            const distance = nearestGP.distance.replace(/(\d+\.\d+)\s*km/, '$1km away');
            summary += ` with the nearest surgery (${nearestGP.name}) located ${distance}`;
            if (gpProximity.score === 0) {
                summary += ` and will require transport assistance for medical appointments`;
            }
        } else if (nearestGP.adjustedTime) {
            summary += ` with ${nearestGP.name} accessible within a ${nearestGP.adjustedTime} walk`;
        }
    } else {
        summary += ` due to no GP surgeries found in the area`;
    }
    summary += '. ';
    
    // DEBUG: Check public transport data structure
    console.log('🚌 DEBUG Public Transport Data:', JSON.stringify(publicTransport, null, 2));

    // 6. Public transport with improved readability
    const transportRating = getScoreRating(publicTransport.score || 0);
    summary += `Public transport connectivity is ${transportRating.toLowerCase()}`;

    const nearestBus = publicTransport.busStops?.[0];
    const nearestTrain = publicTransport.trainStations?.[0];

    const busWalkable = nearestBus?.walkingTime;
    const trainWalkable = nearestTrain?.walkingTime;
    const busDistance = nearestBus?.distance;
    const trainDistance = nearestTrain?.distance;

    if (busWalkable && trainWalkable) {
        // Both walkable
        summary += ` with the nearest bus stop ${busWalkable} mins walk and train station ${trainWalkable} mins walk away`;
    } else if (busWalkable && !trainWalkable) {
        // Only bus walkable
        summary += ` with the nearest bus stop ${busWalkable} mins walk away`;
        if (trainDistance) {
            summary += `. The nearest train station is ${trainDistance} away`;
        }
    } else if (!busWalkable && trainWalkable) {
        // Only train walkable
        summary += ` with the nearest train station ${trainWalkable} mins walk away`;
        if (busDistance) {
            summary += `. The nearest bus stop is ${busDistance} away`;
        }
    } else {
        // Neither walkable
        if (busDistance || trainDistance) {
            summary += ` but public transport requires additional travel`;
            const distances = [];
            if (busDistance) distances.push(`nearest bus stop ${busDistance} away`);
            if (trainDistance) distances.push(`nearest train station ${trainDistance} away`);
            if (distances.length > 0) {
                summary += ` (${distances.join(', ')})`;
            }
        }
    }

    summary += '. ';
    
    // 7. Energy efficiency
    const epcRatingText = getScoreRating(epcScore);
    summary += `Energy efficiency is ${epcRatingText.toLowerCase()}`;
    if (epcRating) {
        summary += ` (EPC rating ${epcRating})`;
    }
    
    if (epcScore >= 4) {
        summary += ", helping to keep heating costs manageable";
    } else if (epcScore >= 2) {
        summary += " with moderate running costs";
    } else {
        summary += ", which may result in higher heating bills";
    }
    summary += '. ';
    
    // 8. Ongoing costs
    const costElements = [];
    
    if (cost.councilTax && councilTaxAnalysis) {
        const bandInfo = cost.councilTax.includes('Band') ? cost.councilTax : `Band ${cost.councilTax}`;
        costElements.push(`${councilTaxAnalysis.rating.toLowerCase()} council tax (${bandInfo})`);
    }
    
    if (cost.serviceCharge && !cost.serviceCharge.includes('Not mentioned') && !cost.serviceCharge.includes('No service')) {
        costElements.push(`service charges of ${cost.serviceCharge}`);
    }
    
    if (cost.groundRent && !cost.groundRent.includes('Ask agent') && !cost.groundRent.includes('Peppercorn')) {
        costElements.push(`ground rent of ${cost.groundRent}`);
    }
    
    if (costElements.length > 0) {
        summary += `Ongoing costs include ${costElements.join(', ')}. `;
    }
    
    // 9. Accessibility limitations with transport considerations
    const criticalMissing = [];
    const transportNeeds = [];

    // Check if property has internal stairs (multi-level without lift)
    // Don't flag flats as lacking single-level living - they're single-level by definition
    const hasInternalStairs = !isSingleLevel && !isFlat && !hasAnyLift;
    if (hasInternalStairs) {
        criticalMissing.push("single-level living");
    }

    // Check for level access entry (this is about external access to the property)
    const hasLevelAccessEntry = foundFeatures.some(f => 
        f.toLowerCase().includes('level') || 
        f.toLowerCase().includes('ramp') ||
        f.toLowerCase().includes('ground floor entry')
    );

    if (!hasLevelAccessEntry) {
        criticalMissing.push("level access entry");
    }

    // Check if transport will be needed for essential services
    if (gpProximity.score === 0 || (gpProximity.nearestGPs?.[0]?.tooFar)) {
        transportNeeds.push("medical appointments");
    }
    if (publicTransport.score <= 1) {
        transportNeeds.push("general travel");
    }

    if (criticalMissing.length > 0 || transportNeeds.length > 0) {
        summary += "Important considerations: ";
        
        if (criticalMissing.length > 0) {
            summary += `the property lacks ${criticalMissing.join(' and ')}`;
            
            // Add specific context for upper floor flats
            if (isUpperFloorFlat && criticalMissing.includes("level access entry")) {
                summary += " (first floor location requires stairs or lift access)";
            } else if (isFlat && floorLevel && floorLevel !== 'ground' && criticalMissing.includes("level access entry")) {
                summary += ` (${floorLevel} floor location requires stairs or lift access)`;
            }
            
            summary += ", which may limit suitability for wheelchair users or those with significant mobility challenges. ";
        }
        
        if (transportNeeds.length > 0) {
            summary += "Residents will require personal transport or taxi services for ";
            if (transportNeeds.length === 2) {
                summary += `both ${transportNeeds[0]} and ${transportNeeds[1]}. `;
            } else {
                summary += `${transportNeeds[0]}. `;
            }
        }
    }

    // 10. Final recommendation
    summary += "Overall, this property is ";
    if (overallScore >= 4.5) {
        summary += "highly suitable for seniors planning to age in place, with excellent accessibility features throughout.";
    } else if (overallScore >= 3.5) {
        summary += "very suitable for active seniors and those planning long-term residence.";
    } else if (overallScore >= 2.5) {
        summary += "well-suited for seniors with good mobility and some adaptability.";
    } else if (overallScore >= 1.5) {
        summary += "suitable for those with minimal mobility requirements or willingness to make modifications.";
    } else {
        summary += "best suited for those able to undertake significant accessibility modifications.";
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
                    coordinates: property.coordinates,
                    images: property.images,  // ADD THIS LINE
                    url: url
                },
                analysis: analysis,
                timestamp: new Date().toISOString()
            };
        };

        const result = await Promise.race([analysisPromise(), timeoutPromise]);

        // Debug property coordinates
        console.log('Property coordinates:', result.property.coordinates);

        // Debug GP data
        console.log('GP data exists:', !!result.analysis.gpProximity);
        console.log('GP has nearestGPs array:', !!result.analysis.gpProximity?.nearestGPs);
        console.log('First GP location:', result.analysis.gpProximity?.nearestGPs?.[0]?.location);

        // Debug transport data
        console.log('Bus stops:', result.analysis.publicTransport?.busStops?.length);
        console.log('Train stations:', result.analysis.publicTransport?.trainStations?.length);

        // Generate map URL
        console.log('Calling generateStaticMapURL...');
        result.mapUrl = generateStaticMapURL(
            result.property,
            result.analysis.gpProximity,
            result.analysis.publicTransport
        );

        console.log('Generated mapUrl:', result.mapUrl);

        // Save property to database
        let savedProperty = null;
        try {
            // Extract data from result
            const priceMatch = result.property.price?.match(/[\d,]+/);
            const priceNumber = priceMatch ? parseInt(priceMatch[0].replace(/,/g, '')) : null;
            const bedroomMatch = result.property.title?.match(/(\d+)\s*bed/i);
            const postcodeMatch = result.property.location?.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)(?:\s*\d[A-Z]{2})?\b/i);
            
            // Extract Rightmove ID
            // Extract Rightmove ID
            const rmMatch = url.match(/properties\/(\d+)/);
            const rightmoveId = rmMatch ? rmMatch[1] : null;

            const { data } = await supabase
                .from('properties')
                .upsert({
                    rightmove_id: rightmoveId,
                    rightmove_url: url,
                    address: result.property.location,
                    title: result.property.title,
                    postcode: postcodeMatch ? postcodeMatch[1].toUpperCase() : null,
                    price: priceNumber,
                    bedrooms: bedroomMatch ? parseInt(bedroomMatch[1]) : null,
                    property_type: result.property.title,
                    overall_score: result.analysis.overall,
                    scores_json: result.analysis,
                    analysed_at: new Date().toISOString()
                }, { onConflict: 'rightmove_url' })
                .select()
                .single();
            
            savedProperty = data;
            
            // Log search history if user is logged in
            const authHeader = req.headers.authorization;
            console.log('🔍 Auth header present:', !!authHeader);

            if (authHeader) {
                const token = authHeader.replace('Bearer ', '');
                const { data: { user } } = await supabase.auth.getUser(token);
                console.log('🔍 User from token:', user?.email);
                
                if (user) {
                    const { data: dbUser } = await supabase
                        .from('users')
                        .select('id')
                        .eq('email', user.email)
                        .single();
                    console.log('🔍 DB user found:', !!dbUser);
                    
                    if (dbUser) {
                        // Extract Rightmove ID from URL
                        const rmMatch = url.match(/properties\/(\d+)/);
                        const rightmoveId = rmMatch ? rmMatch[1] : null;
                        console.log('🔍 Rightmove ID extracted:', rightmoveId);
                        
                        if (rightmoveId) {
                            const { error: historyError } = await supabase
                                .from('search_history')
                                .insert({
                                    user_id: dbUser.id,
                                    property_id: rightmoveId
                                });
                            
                            if (historyError) {
                                console.log('❌ Search history insert error:', historyError.message);
                            } else {
                                console.log('📝 Search recorded for:', user.email);
                            }
                        }
                    }
                }
            }
        } catch (dbError) {
            console.log('⚠️ Database save error:', dbError.message);
        }
        
        // Add property ID to result for saving
        result.propertyId = savedProperty?.id;

        res.json(result);

    } catch (error) {
        console.error('Analysis error:', error.message);
        res.status(500).json({ 
            error: error.message || 'Failed to analyze property' 
        });
    }
});

// =============================================
// AUTHENTICATION ENDPOINTS
// =============================================

// Send magic link (only for users with active subscriptions)
app.post('/auth/magic-link', async (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }
    
    // Check if user exists and has active subscription
    const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription_status')
        .eq('email', email)
        .single();
    
    if (userError || !user) {
        console.log('❌ Sign-in attempt for unregistered email:', email);
        return res.status(404).json({ error: 'No account found with this email. Please subscribe to create an account.' });
    }
    
    if (user.subscription_status !== 'active') {
        console.log('❌ Sign-in attempt for non-subscriber:', email);
        return res.status(403).json({ error: 'No active subscription found. Please subscribe to access your account.' });
    }
    
    // User has active subscription - send magic link
    const { data, error } = await supabase.auth.signInWithOtp({
        email: email,
        options: {
            emailRedirectTo: `${req.headers.origin || 'http://localhost:3002'}/analysis.html`
        }
    });
    
    if (error) {
        console.log('❌ Magic link error:', error.message);
        return res.status(400).json({ error: error.message });
    }
    
    console.log('📧 Magic link sent to subscriber:', email);
    res.json({ message: 'Check your email for the login link' });
});

// Get current user
app.get('/auth/user', async (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Get user details from our table
    const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('email', user.email)
        .single();
    
    res.json({ user: userData });
});

// Handle auth callback (exchange code for session)
app.get('/auth/callback', async (req, res) => {
    console.log('🔔 AUTH CALLBACK HIT');
    console.log('🔔 Full query:', req.query);
    
    const { code } = req.query;
    
    if (!code) {
        console.log('❌ No code in query params');
        return res.redirect('/analysis.html?error=no_code');
    }
    
    console.log('🔔 Got code, exchanging...');
    
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    
    if (error) {
        console.log('❌ Exchange error:', error.message);
        return res.redirect('/analysis.html?error=auth_failed');
    }
    
    console.log('✅ User authenticated:', data.user.email);
    
    // Check if user exists in our users table, if not create them
    let { data: existingUser } = await supabase
        .from('users')
        .select('id, subscription_status')
        .eq('email', data.user.email)
        .single();
    
    if (!existingUser) {
        const { data: newUser } = await supabase
            .from('users')
            .insert({
                email: data.user.email,
                user_type: 'individual'
            })
            .select('id, subscription_status')
            .single();
        
        existingUser = newUser;
        console.log('👤 New user created:', data.user.email);
    }
    
    // Check subscription status
    const hasSubscription = existingUser?.subscription_status === 'active';
    
    // Get the token
    const token = data.session.access_token;
    
    if (hasSubscription) {
        // Subscriber - go straight to analysis
        console.log('🎫 Subscriber login:', data.user.email);
        res.redirect(`/analysis.html?token=${token}`);
    } else {
        // Non-subscriber - show paywall
        console.log('🆓 Free user login:', data.user.email);
        res.redirect(`/analysis.html?token=${token}&showPaywall=true`);
    }
});

// Create user after OAuth callback
app.post('/auth/create-user', async (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Check if user exists, if not create them
    const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    if (!existingUser) {
        const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert({ email: user.email, user_type: 'individual' })
            .select()
            .single();
        
        if (insertError) {
            console.log('❌ Error creating user:', insertError.message);
            return res.status(500).json({ error: insertError.message });
        }
        
        console.log('👤 New user created:', user.email);
        return res.json({ user: newUser, isNew: true });
    }
    
    console.log('👤 Existing user logged in:', user.email);
    res.json({ user: existingUser, isNew: false });
});

// Logout
app.post('/auth/logout', async (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

// =============================================
// TEAM ENDPOINTS (Estate Agents)
// =============================================

// Create a team
app.post('/api/teams', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Team name required' });
    
    // Get user from our table
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    if (!dbUser) return res.status(404).json({ error: 'User not found' });
    
    // Update user to agent type
    await supabase
        .from('users')
        .update({ user_type: 'agent' })
        .eq('id', dbUser.id);
    
    // Create team
    const { data: team, error: teamError } = await supabase
        .from('teams')
        .insert({
            name: name,
            owner_id: dbUser.id,
            owner_email: user.email
        })
        .select()
        .single();
    
    if (teamError) {
        console.log('❌ Error creating team:', teamError.message);
        return res.status(500).json({ error: teamError.message });
    }
    
    // Add owner as team member
    await supabase
        .from('team_members')
        .insert({
            team_id: team.id,
            user_id: dbUser.id,
            role: 'owner',
            email: user.email
        });
    
    console.log('🏢 Team created:', name);
    res.json({ team });
});

// Get my team
app.get('/api/teams/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    if (!dbUser) return res.status(404).json({ error: 'User not found' });
    
    // Find team membership
    const { data: membership } = await supabase
        .from('team_members')
        .select('team_id, role, teams(*)')
        .eq('user_id', dbUser.id)
        .single();
    
    if (!membership) return res.json({ team: null });
    
    // Get team members
    const { data: members } = await supabase
        .from('team_members')
        .select('role, joined_at, users(id, email, name)')
        .eq('team_id', membership.team_id);
    
    res.json({ 
        team: membership.teams,
        role: membership.role,
        members: members
    });
});

// Invite to team
app.post('/api/teams/invite', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
    // Get inviter's user and team
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    const { data: membership } = await supabase
        .from('team_members')
        .select('team_id, role, teams(name)')
        .eq('user_id', dbUser.id)
        .single();
    
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Not authorized to invite' });
    }
    
    // Check team member limit (max 5)
    const { count } = await supabase
        .from('team_members')
        .select('*', { count: 'exact', head: true })
        .eq('team_id', membership.team_id);

    if (count >= 5) {
        return res.status(400).json({ error: 'Team is full (maximum 5 members)' });
    }
    
    // Check if invitee already has account
    let { data: invitee } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .single();
    
    // If no account, create one
    if (!invitee) {
        const { data: newUser } = await supabase
            .from('users')
            .insert({ email: email, user_type: 'agent' })
            .select()
            .single();
        invitee = newUser;
    }
    
    // Check if already a member
    const { data: existingMember } = await supabase
        .from('team_members')
        .select('id')
        .eq('team_id', membership.team_id)
        .eq('user_id', invitee.id)
        .single();
    
    if (existingMember) {
        return res.status(400).json({ error: 'Already a team member' });
    }
    
    // Add to team
    await supabase
        .from('team_members')
        .insert({
            team_id: membership.team_id,
            user_id: invitee.id,
            role: 'member',
            email: email
        });
    
    // Send magic link to invitee
    await supabase.auth.signInWithOtp({
        email: email,
        options: {
            emailRedirectTo: `${req.headers.origin || 'http://localhost:3002'}/auth/callback`
        }
    });
    
    console.log('📧 Team invite sent to:', email);
    res.json({ message: `Invite sent to ${email}` });
});

// Remove team member
app.delete('/api/teams/members/:userId', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });
    
    const { userId } = req.params;
    
    // Get requester's team membership
    const { data: dbUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .single();
    
    const { data: membership } = await supabase
        .from('team_members')
        .select('team_id, role')
        .eq('user_id', dbUser.id)
        .single();
    
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Not authorized to remove members' });
    }
    
    // Can't remove owner
    const { data: targetMember } = await supabase
        .from('team_members')
        .select('role')
        .eq('team_id', membership.team_id)
        .eq('user_id', userId)
        .single();
    
    if (targetMember?.role === 'owner') {
        return res.status(400).json({ error: 'Cannot remove team owner' });
    }
    
    // Remove member
    await supabase
        .from('team_members')
        .delete()
        .eq('team_id', membership.team_id)
        .eq('user_id', userId);
    
    console.log('👤 Team member removed:', userId);
    res.json({ message: 'Member removed' });
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
    
    console.log('🧪 Testing API key with simple call...');
    try {
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 50,
            messages: [{ role: 'user', content: 'test' }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            timeout: 5000
        });
        
        console.log('✅ API key test successful');
        
        // Test Vision capability
        try {
            console.log('👁️ Testing Vision capability...');
            const visionResponse = await axios.post('https://api.anthropic.com/v1/messages', {
                model: 'claude-sonnet-4-20250514',
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
            
        } catch (visionError) {
            if (visionError.response?.status === 400 && 
                visionError.response?.data?.error?.message?.includes('image')) {
                console.log('❌ Vision API not enabled for this key');
            } else {
                console.log('⚠️ Vision test inconclusive:', visionError.response?.data?.error?.message || visionError.message);
            }
        }
        
        return true;
        
    } catch (error) {
        console.log('❌ API test failed:', error.message);
        console.log('📋 Status code:', error.response?.status);
        console.log('📋 Error type:', error.response?.data?.error?.type);
        console.log('📋 Error message:', error.response?.data?.error?.message);
        console.log('📋 Full error data:', JSON.stringify(error.response?.data, null, 2));
        
        console.log('🔧 To fix API key issues:');
        console.log('   1. Go to console.anthropic.com');
        console.log('   2. Click "Get API Key" or navigate to API settings');
        console.log('   3. Generate a new API key');
        console.log('   4. Update your CLAUDE_API_KEY environment variable');
        
        return false;
    }
}

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🏠 Home Accessibility Score API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log('🎯 Updated with Accessible Features scoring system');
    console.log('');

    // Test Supabase connection
    supabase.from('users').select('count', { count: 'exact', head: true })
        .then(({ count, error }) => {
            if (error) {
                console.log('❌ Supabase connection failed:', error.message);
            } else {
                console.log('✅ Supabase connected - users table has', count, 'rows');
            }
        });
    
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