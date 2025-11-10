import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';

const app = Fastify({ logger: true });

// Configuration
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const USER_DATA_DIR = path.join(DATA_DIR, 'chrome_profile');

// Global state
let browser: BrowserContext | null = null;
let page: Page | null = null;
let isWhatsAppReady = false;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize WhatsApp Web connection
async function initWhatsApp() {
  try {
    console.log('🚀 Launching browser...');
    
    browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-blink-features=AutomationControlled',  // Hide automation
      ],
      // Set proper user agent to avoid browser compatibility issues
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      // Add extra context options to avoid detection
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    const pages = browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    console.log('🌐 Navigating to WhatsApp Web...');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle' });
    
    // Dismiss any download/desktop app prompts
    console.log('⏳ Checking for download prompts to dismiss...');
    await page.waitForTimeout(2000);
    try {
      // Look for "Download" or "Use WhatsApp on your computer" dialog
      const closeSelectors = [
        'button[aria-label*="Close"]',
        'button[aria-label*="cancel"]',
        'button[aria-label*="Dismiss"]',
        '[data-testid="popup-close"]',
        'div[role="button"]:has-text("Cancel")',
        'div[role="button"]:has-text("Not now")',
      ];
      
      for (const selector of closeSelectors) {
        try {
          const elem = page.locator(selector).first();
          if (await elem.isVisible({ timeout: 1000 })) {
            await elem.click();
            console.log(`✅ Dismissed prompt using: ${selector}`);
            await page.waitForTimeout(1000);
            break;
          }
        } catch {
          // Continue trying other selectors
        }
      }
    } catch (e) {
      console.log('⚠️ No dismissible prompts found or error dismissing:', e);
    }
    
    console.log('⏳ Waiting for WhatsApp to load...');
    
    // Wait for either login page or main interface
    // Important: When session is saved, WhatsApp needs time to verify with servers
    // This can take 90-120 seconds on slower connections or when session needs validation
    try {
      console.log('⏳ Checking for existing session... (this may take up to 120 seconds)');
      console.log('💡 If you see this taking too long, the session may have expired. You will need to scan QR code again.');
      
      // Try multiple selectors that indicate WhatsApp is authenticated
      const authenticatedSelectors = [
        '[data-testid="chat-list"]',           // Primary selector
        '#pane-side',                           // Side panel with chats
        'div[aria-label*="Chat list"]',        // Chat list container
        'div[title="Search input textbox"]',   // Search box (only present when authenticated)
        '[data-testid="search"]',              // Alternative search selector
      ];
      
      let authenticated = false;
      for (const selector of authenticatedSelectors) {
        try {
          console.log(`   Trying selector: ${selector}`);
          await page.waitForSelector(selector, { timeout: 25000 });
          authenticated = true;
          console.log(`   ✅ Found authentication indicator: ${selector}`);
          break;
        } catch {
          console.log(`   ⏭️  Selector not found: ${selector}`);
          continue;
        }
      }
      
      if (authenticated) {
        isWhatsAppReady = true;
        console.log('✅ WhatsApp is authenticated and ready!');
      } else {
        throw new Error('No authentication indicators found');
      }
    } catch {
      // Check if QR code is visible (means no saved session)
      console.log('⚠️ No authentication found, checking for QR code...');
      const qrVisible = await page.locator('canvas[aria-label*="QR"], canvas[aria-label*="Scan"]').isVisible({ timeout: 5000 }).catch(() => false);
      if (qrVisible) {
        console.log('📱 WhatsApp not authenticated. QR code available at GET /qr');
        isWhatsAppReady = false;
      } else {
        // Still loading, check again after a bit
        console.log('⏳ WhatsApp still loading, checking authentication status one more time...');
        await page.waitForTimeout(10000);
        
        // Try all selectors again after wait
        const finalSelectors = [
          '[data-testid="chat-list"]',
          '#pane-side',
          'div[aria-label*="Chat list"]',
          'div[title="Search input textbox"]',
        ];
        
        let foundAfterWait = false;
        for (const selector of finalSelectors) {
          const visible = await page.locator(selector).isVisible({ timeout: 2000 }).catch(() => false);
          if (visible) {
            console.log(`   ✅ Found after wait: ${selector}`);
            foundAfterWait = true;
            break;
          }
        }
        
        if (foundAfterWait) {
          isWhatsAppReady = true;
          console.log('✅ WhatsApp authenticated after additional wait!');
        } else {
          console.log('❌ Still not authenticated');
          isWhatsAppReady = false;
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp:', error);
    return false;
  }
}

// Get QR code as base64 image
async function getQRCode(): Promise<{ success: boolean; qr?: string; message: string }> {
  if (!page) {
    return { success: false, message: 'WhatsApp not initialized' };
  }

  try {
    console.log('🔍 Looking for QR code...');
    
    // WhatsApp now uses an image element for QR code, not canvas
    const imageSelector = 'img[alt*="Scan"], img[alt*="QR"], img[aria-label*="QR"]';
    const canvasSelector = 'canvas[aria-label*="QR"], canvas[aria-label*="Scan"], div[data-ref] canvas';
    
    let qrElement = null;
    
    try {
      // Try image selector first (newer WhatsApp)
      console.log(`   Trying IMAGE selector: ${imageSelector}`);
      await page.waitForSelector(imageSelector, { timeout: 5000 });
      qrElement = page.locator(imageSelector).first();
      console.log('✅ Found QR code as IMAGE element');
    } catch (imageError) {
      console.log(`   ⚠️ Image selector failed: ${imageError.message}`);
      try {
        // Fallback to canvas selector (older WhatsApp)
        console.log(`   Trying CANVAS selector: ${canvasSelector}`);
        await page.waitForSelector(canvasSelector, { timeout: 5000 });
        qrElement = page.locator(canvasSelector).first();
        console.log('✅ Found QR code as CANVAS element');
      } catch (canvasError) {
        console.log(`   ⚠️ Canvas selector failed: ${canvasError.message}`);
        // Check if already authenticated
        const isAuth = await page.locator('[data-testid="chat-list"]').isVisible({ timeout: 2000 }).catch(() => false);
        if (isAuth) {
          console.log('   ℹ️ User is already authenticated, no QR needed');
          return { success: false, message: 'Already authenticated. No QR code available.' };
        }
        console.log('   ❌ QR code element not found on page');
        return { success: false, message: 'QR code not found. Page may still be loading.' };
      }
    }

    // Take screenshot of the QR code area
    const qrScreenshot = await qrElement.screenshot({ type: 'png' });
    const qrBase64 = qrScreenshot.toString('base64');
    
    console.log('✅ QR code captured successfully');
    
    return {
      success: true,
      qr: `data:image/png;base64,${qrBase64}`,
      message: 'QR code ready. Scan with WhatsApp mobile app: Settings > Linked Devices > Link a Device'
    };
  } catch (error) {
    console.error('❌ Failed to get QR code:', error);
    return { success: false, message: `Error: ${error}` };
  }
}

// Submit phone number for login and return verification code
async function submitPhoneNumber(phoneNumber: string): Promise<{ success: boolean; code?: string; message: string }> {
  if (!page) {
    throw new Error('WhatsApp not initialized');
  }

  try {
    console.log(`📱 Submitting phone number: ${phoneNumber}`);
    
    // Clean phone number (remove non-digits)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    // Wait for phone input field
    await page.waitForTimeout(2000);
    
    // Try to find and click "Log in with phone number" button first
    try {
      // Use multiple approaches to find the button
      const buttonSelectors = [
        'button:text("Log in with phone number")',
        'button:has-text("Log in with phone number")',
        '//button[contains(text(), "Log in with phone number")]',
        '//button[text()="Log in with phone number"]',
      ];
      
      let buttonClicked = false;
      for (const selector of buttonSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 })) {
            await btn.click();
            console.log(`✅ Clicked "Log in with phone number" button using selector: ${selector}`);
            buttonClicked = true;
            await page.waitForTimeout(3000);
            break;
          }
        } catch {
          continue;
        }
      }
      
      if (!buttonClicked) {
        console.log('⚠️ Could not find phone login button, trying alternative selectors');
        // Try looking for links or other elements with phone number text
        const altSelectors = [
          'a:has-text("phone number")',
          '*:has-text("Link with phone number")',
          '[role="button"]:has-text("phone")',
        ];
        
        for (const selector of altSelectors) {
          try {
            const elem = page.locator(selector).first();
            if (await elem.isVisible({ timeout: 2000 })) {
              await elem.click();
              console.log(`✅ Clicked element using selector: ${selector}`);
              buttonClicked = true;
              await page.waitForTimeout(5000);
              break;
            }
          } catch {
            continue;
          }
        }
        
        if (!buttonClicked) {
          console.log('⚠️ Trying JS click as final fallback');
          await page.evaluate(() => {
            // Try finding any clickable element with "phone" in it
            const allElements = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
            const phoneElement = allElements.find(el => 
              el.textContent?.toLowerCase().includes('phone') || 
              el.textContent?.toLowerCase().includes('link')
            );
            if (phoneElement) {
              (phoneElement as HTMLElement).click();
              return true;
            }
            return false;
          });
          console.log('✅ Clicked element via JavaScript');
        }
        
        await page.waitForTimeout(5000);
        
        // Check for iframes
        const frames = page.frames();
        console.log(`📋 Found ${frames.length} frames on the page`);
        
        // Check for modal/overlay elements
        const modalSelectors = [
          '[role="dialog"]',
          '.modal',
          '[class*="modal"]',
          '[class*="overlay"]',
          'div[tabindex="-1"]'
        ];
        for (const selector of modalSelectors) {
          try {
            const modal = page.locator(selector);
            if (await modal.isVisible({ timeout: 1000 })) {
              console.log(`📋 Found modal with selector: ${selector}`);
            }
          } catch {
            // No modal found
          }
        }
        
        // Take debug screenshot
        try {
          await page.screenshot({ path: './data/after_button_click.png', fullPage: true });
          console.log('📸 Screenshot saved to ./data/after_button_click.png');
        } catch (e) {
          console.log('⚠️ Could not save screenshot');
        }
      }
    } catch (err) {
      console.log(`ℹ️ Phone login button error: ${err}`);
    }
    
    // Look for phone input field - WhatsApp uses a textbox with "Type your phone number" placeholder
    console.log('🔍 Looking for phone input field...');
    
    // Debug: check what's on the page
    const currentUrl = page.url();
    const pageText = await page.textContent('body');
    console.log(`📍 Current URL: ${currentUrl}`);
    console.log(`📄 Page text snippet: ${pageText?.substring(0, 200)}`);
    
    // Check for all input fields on the page for debugging
    const allInputs = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(inp => ({
        type: inp.type,
        placeholder: inp.placeholder,
        ariaLabel: inp.getAttribute('aria-label'),
        role: inp.getAttribute('role'),
        visible: inp.offsetParent !== null
      }));
    });
    console.log(`📋 Found ${allInputs.length} input fields:`, JSON.stringify(allInputs));
    
    const phoneInputSelectors = [
      'input[aria-label="Type your phone number."]',
      'input[placeholder="Type your phone number."]',
      'input[type="tel"]',
      'input[role="textbox"]',
    ];
    
    let phoneInput = null;
    for (const selector of phoneInputSelectors) {
      try {
        console.log(`   Trying selector: ${selector}`);
        phoneInput = page.locator(selector).first();
        if (await phoneInput.isVisible({ timeout: 3000 })) {
          console.log(`   ✅ Found phone input with: ${selector}`);
          break;
        }
      } catch (e) {
        console.log(`   ❌ Failed with selector: ${selector}`);
        continue;
      }
    }
    
    if (!phoneInput) {
      console.log('⚠️ Playwright selectors failed, using JavaScript fallback...');
      // Use JavaScript as fallback
      const filled = await page.evaluate((phone: any) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const phoneInput = inputs.find((inp: any) => 
          inp.placeholder?.toLowerCase().includes('phone') ||
          inp.getAttribute('aria-label')?.toLowerCase().includes('phone') ||
          inp.type === 'tel' ||
          inp.getAttribute('role') === 'textbox'
        );
        if (phoneInput) {
          (phoneInput as any).value = phone;
          (phoneInput as any).dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, cleanPhone);
      
      if (!filled) {
        throw new Error('Could not find phone input field with any method');
      }
      console.log('✅ Phone number entered via JavaScript');
    } else {
      // Fill phone number using Playwright
      await phoneInput.fill(cleanPhone);
      console.log('✅ Phone number entered via Playwright');
    }
    await page.waitForTimeout(1000);
    
    // Click Next/Submit button
    const nextButtonSelectors = [
      'button:has-text("Next")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'div[role="button"]:has-text("Next")',
    ];
    
    for (const selector of nextButtonSelectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 2000 })) {
          await button.click();
          console.log('✅ Clicked Next button');
          break;
        }
      } catch {
        continue;
      }
    }
    
    await page.waitForTimeout(3000);
    console.log('✅ Phone number submitted. Checking for verification code...');
    
    // Try to extract the verification code from the screen
    const code = await getVerificationCode();
    
    if (code) {
      console.log(`✅ Verification code found: ${code}`);
      return { 
        success: true, 
        code, 
        message: `Phone number submitted. Verification code: ${code}. Enter this code on your phone in WhatsApp > Settings > Linked Devices > Link with phone number.` 
      };
    } else {
      return { 
        success: true, 
        message: 'Phone number submitted. Verification code sent to your phone. Enter it on your phone in WhatsApp > Settings > Linked Devices.' 
      };
    }
  } catch (error) {
    console.error('❌ Failed to submit phone number:', error);
    throw error;
  }
}

// Get verification code from screen
async function getVerificationCode(): Promise<string | null> {
  if (!page) {
    throw new Error('WhatsApp not initialized');
  }

  try {
    console.log('🔍 Looking for verification code on screen...');
    
    // Wait a moment for code to appear
    await page.waitForTimeout(2000);
    
    // WhatsApp displays code as individual characters in separate elements
    // Look for the "Enter code on phone:" container and extract all characters
    try {
      const codeContainer = page.locator('[aria-label="Enter code on phone:"]').first();
      if (await codeContainer.isVisible({ timeout: 2000 })) {
        const codeText = await codeContainer.textContent();
        if (codeText) {
          // Remove all whitespace and join characters
          const cleanCode = codeText.replace(/\s+/g, '');
          if (cleanCode.length >= 6) {
            console.log(`✅ Found verification code: ${cleanCode}`);
            return cleanCode;
          }
        }
      }
    } catch {
      // Continue to other methods
    }
    
    // Fallback: Try to extract any 8-character alphanumeric code from page
    const pageText = await page.textContent('body');
    const codeMatch = pageText?.match(/\b([A-Z0-9]{8})\b/);
    if (codeMatch) {
      console.log(`✅ Found verification code from page text: ${codeMatch[1]}`);
      return codeMatch[1];
    }
    
    console.log('⚠️ Verification code not found on screen');
    return null;
  } catch (error) {
    console.error('❌ Error getting verification code:', error);
    return null;
  }
}

// Enter verification code into WhatsApp Web to complete phone login
async function enterVerificationCode(code: string): Promise<boolean> {
  if (!page) throw new Error('WhatsApp not initialized');

  try {
    console.log(`🔑 Entering verification code: ${code}`);

    // Look for code input fields (could be multiple boxes or a single input)
    const codeInputSelectors = [
      'input[type="tel"]',
      'input[aria-label*="verification" i]',
      'input[placeholder*="code" i]',
      'input[autocomplete="one-time-code"]',
      'input[type="text"]',
    ];

    // Try to find a single input field
    for (const selector of codeInputSelectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.fill(code);
          console.log('✅ Filled verification input');
          // Try to submit
          try {
            await el.press('Enter');
          } catch {}
          await page.waitForTimeout(2000);
          break;
        }
      } catch {
        continue;
      }
    }

    // As a fallback, try to paste code into any focused element via JS
    try {
      await page.evaluate((c: any) => {
        const doc: any = (globalThis as any).document;
        const inputs: any[] = Array.from(doc.querySelectorAll('input, textarea'));
        for (const i of inputs) {
          const txt = (i.placeholder || i.ariaLabel || '');
          if (/code|verification|pin|one-time/i.test(txt) || i.type === 'text') {
            try { i.focus(); } catch {}
            try { i.value = String(c); } catch {}
            try { i.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true })); } catch {}
            break;
          }
        }
      }, code as any);
      await page.waitForTimeout(1000);
    } catch (e) {
      // ignore
    }

    // Click any confirm/verify button
    const verifySelectors = [
      'button:has-text("Verify")',
      'button:has-text("Confirm")',
      'button[type="submit"]',
      'div[role="button"]:has-text("Verify")',
    ];

    for (const sel of verifySelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          console.log('✅ Clicked verify/confirm button');
          break;
        }
      } catch {
        continue;
      }
    }

    // Wait for main chat list to appear
    try {
      await page.waitForSelector('[data-testid="chat-list"]', { timeout: 15000 });
      isWhatsAppReady = true;
      console.log('🎉 Phone login successful — WhatsApp is ready');
      return true;
    } catch {
      console.log('⚠️ Verification step may not have completed yet');
      return false;
    }
  } catch (error) {
    console.error('❌ enterVerificationCode error:', error);
    throw error;
  }
}

// API endpoints for phone login flow
app.post<{
  Body: { phone_number: string }
}>('/login', async (request, reply) => {
  try {
    const phone = request.body.phone_number;
    if (!phone) {
      return reply.code(400).send({ status: 'error', message: 'phone_number is required' });
    }

    if (!page) return reply.code(503).send({ status: 'error', message: 'WhatsApp not initialized' });

    const result = await submitPhoneNumber(phone);
    return reply.code(200).send(result);
  } catch (error) {
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

app.get('/code', async (request, reply) => {
  try {
    const code = await getVerificationCode();
    if (code) {
      return reply.code(200).send({ 
        status: 'found', 
        verification_code: code,
        message: 'Enter this code on your phone: WhatsApp > Settings > Linked Devices > Link with phone number'
      });
    }
    return reply.code(404).send({ status: 'code_not_found', message: 'Verification code not found on screen. It may have been sent directly to your phone.' });
  } catch (error) {
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

// Refresh/retry code if expired - clicks "edit" button and allows re-entering phone number
app.post('/refresh-code', async (request, reply) => {
  try {
    if (!page) return reply.code(503).send({ status: 'error', message: 'WhatsApp not initialized' });
    
    console.log('🔄 Attempting to refresh verification code...');
    
    // Look for "edit" button on the code screen (allows changing phone number)
    const editButtonFound = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const editBtn = buttons.find(b => b.textContent?.toLowerCase().includes('edit'));
      if (editBtn) {
        (editBtn as HTMLElement).click();
        return true;
      }
      return false;
    });
    
    if (editButtonFound) {
      await page.waitForTimeout(2000);
      console.log('✅ Clicked edit button. You can now call POST /login again with the same or different phone number.');
      return reply.code(200).send({ 
        status: 'ready_for_retry', 
        message: 'Code screen reset. Call POST /login again to get a new verification code.' 
      });
    }
    
    // Alternative: check if we're still on code screen and just refresh
    const pageText = await page.textContent('body');
    if (pageText?.includes('Enter code on phone')) {
      // Already on code screen, get the current code
      const code = await getVerificationCode();
      if (code) {
        return reply.code(200).send({ 
          status: 'code_available', 
          verification_code: code,
          message: 'Current verification code is still displayed. If expired, use the edit button on WhatsApp Web or restart login flow.' 
        });
      }
    }
    
    return reply.code(400).send({ 
      status: 'cannot_refresh', 
      message: 'Not on verification code screen. Call POST /login first to start the login flow.' 
    });
  } catch (error) {
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

app.post<{
  Body: { code: string }
}>('/verify', async (request, reply) => {
  try {
    const code = request.body.code;
    if (!code) return reply.code(400).send({ status: 'error', message: 'code is required' });

    const ok = await enterVerificationCode(code);
    if (ok) return reply.code(200).send({ status: 'verified', message: 'Verification successful' });
    return reply.code(202).send({ status: 'pending', message: 'Verification attempted but not confirmed yet' });
  } catch (error) {
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});


// Send message function
async function sendMessage(phoneNumber: string, message: string): Promise<boolean> {
  if (!page) {
    throw new Error('WhatsApp not initialized');
  }

  try {
    // Format phone number (remove any non-digit characters)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    // Navigate to chat using WhatsApp's direct URL
    const chatUrl = `https://web.whatsapp.com/send?phone=${cleanPhone}`;
    console.log(`📞 Opening chat for: ${cleanPhone}`);
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    
    // Wait a bit for page to fully load
    await page.waitForTimeout(3000);
    
    // Wait for the message input box
    const inputSelector = 'div[contenteditable="true"][data-tab="10"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    
    console.log('✍️ Typing message...');
    await page.fill(inputSelector, message);
    
    // Wait a moment for the message to be typed
    await page.waitForTimeout(1000);
    
    // Press Enter to send
    await page.keyboard.press('Enter');
    
    console.log('✅ Message sent successfully!');
    await page.waitForTimeout(2000); // Wait for message to send
    
    return true;
  } catch (error) {
    console.error('❌ Failed to send message:', error);
    throw error;
  }
}

// Send message with media function
async function sendMessageWithMedia(
  phoneNumber: string, 
  mediaPath: string, 
  caption?: string
): Promise<boolean> {
  if (!page) {
    throw new Error('WhatsApp not initialized');
  }

  try {
    // Format phone number (remove any non-digit characters)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    // Navigate to chat using WhatsApp's direct URL
    const chatUrl = `https://web.whatsapp.com/send?phone=${cleanPhone}`;
    console.log(`📞 Opening chat for: ${cleanPhone}`);
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    
    // Wait a bit for page to fully load and chat to open
    await page.waitForTimeout(5000);
    
    // Wait for the message input box to appear (indicates chat is loaded)
    const inputSelector = 'div[contenteditable="true"][data-tab="10"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    console.log('✅ Chat loaded successfully');
    
    // Find and click the attachment button (paperclip icon)
    console.log('📎 Looking for attachment button...');
    const attachmentButtonSelectors = [
      'span[data-icon="plus"]',
      'span[data-icon="attach-menu-plus"]',
      'div[title="Attach"]',
      'button[aria-label="Attach"]',
      'div[role="button"][aria-label="Attach"]',
      'span[data-testid="clip"]'
    ];
    
    let attachmentButton = null;
    for (const selector of attachmentButtonSelectors) {
      try {
        attachmentButton = page.locator(selector).first();
        if (await attachmentButton.isVisible({ timeout: 2000 })) {
          console.log(`   ✅ Found attachment button: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }
    
    if (!attachmentButton || !await attachmentButton.isVisible()) {
      throw new Error('Could not find attachment button');
    }
    
    await attachmentButton.click();
    console.log('✅ Clicked attachment button');
    await page.waitForTimeout(1000);
    
    // Find the file input for media upload
    console.log('📁 Looking for file input...');
    const fileInputSelectors = [
      'input[type="file"][accept*="image"]',
      'input[type="file"][accept*="video"]',
      'input[type="file"]'
    ];
    
    let fileInput = null;
    for (const selector of fileInputSelectors) {
      try {
        const input = page.locator(selector).first();
        if (await input.count() > 0) {
          fileInput = input;
          console.log(`   ✅ Found file input: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }
    
    if (!fileInput) {
      throw new Error('Could not find file input for media upload');
    }
    
    // Upload the file
    console.log(`📤 Uploading file: ${mediaPath}`);
    await fileInput.setInputFiles(mediaPath);
    await page.waitForTimeout(2000);
    
    // Add caption if provided
    if (caption) {
      console.log('✍️ Adding caption...');
      const captionSelectors = [
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"].copyable-text',
        'div[role="textbox"]'
      ];
      
      let captionInput = null;
      for (const selector of captionSelectors) {
        try {
          captionInput = page.locator(selector).first();
          if (await captionInput.isVisible({ timeout: 2000 })) {
            console.log(`   ✅ Found caption input: ${selector}`);
            break;
          }
        } catch {
          continue;
        }
      }
      
      if (captionInput && await captionInput.isVisible()) {
        await captionInput.fill(caption);
        await page.waitForTimeout(500);
      } else {
        console.log('⚠️ Could not find caption input, sending without caption');
      }
    }
    
    // Find and click the send button
    console.log('📤 Looking for send button...');
    const sendButtonSelectors = [
      'span[data-icon="send"]',
      'button[aria-label="Send"]',
      'div[role="button"][aria-label="Send"]',
      'span[data-testid="send"]'
    ];
    
    let sendButton = null;
    for (const selector of sendButtonSelectors) {
      try {
        sendButton = page.locator(selector).first();
        if (await sendButton.isVisible({ timeout: 2000 })) {
          console.log(`   ✅ Found send button: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }
    
    if (!sendButton || !await sendButton.isVisible()) {
      throw new Error('Could not find send button');
    }
    
    await sendButton.click();
    console.log('✅ Media message sent successfully!');
    await page.waitForTimeout(3000); // Wait for message to send
    
    return true;
  } catch (error) {
    console.error('❌ Failed to send media message:', error);
    throw error;
  }
}

// Register multipart for file uploads
app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
    files: 1 // Only 1 file per request
  }
});

// File upload endpoint
app.post('/upload', async (request, reply) => {
  try {
    const data = await request.file();
    
    if (!data) {
      return reply.code(400).send({
        status: 'error',
        message: 'No file uploaded'
      });
    }

    // Get filename from the upload, or generate one
    const originalFilename = data.filename;
    const timestamp = Date.now();
    const filename = `${timestamp}-${originalFilename}`;
    const filepath = path.join(DATA_DIR, filename);

    console.log(`📁 Uploading file: ${originalFilename} -> ${filename}`);

    // Save the file
    await pipeline(data.file, fs.createWriteStream(filepath));

    console.log(`✅ File saved: ${filepath}`);

    return reply.code(200).send({
      status: 'success',
      message: 'File uploaded successfully',
      filename: filename,
      original_filename: originalFilename,
      file_path: `/app/data/${filename}`,
      size: fs.statSync(filepath).size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ File upload failed:', error);
    return reply.code(500).send({
      status: 'error',
      message: 'File upload failed',
      error: String(error)
    });
  }
});

// Health check endpoint
app.get('/health', async (request, reply) => {
  try {
    const status = {
      status: isWhatsAppReady ? 'ready' : 'not_ready',
      whatsapp_connected: isWhatsAppReady,
      browser_active: browser !== null && page !== null,
      timestamp: new Date().toISOString(),
    };
    
    return reply.code(200).send(status);
  } catch (error) {
    return reply.code(500).send({
      status: 'error',
      message: 'Health check failed',
      error: String(error),
    });
  }
});

// Send message endpoint
app.post<{
  Body: {
    phone_number: string;
    message: string;
  };
}>('/message', async (request, reply) => {
  try {
    const { phone_number, message } = request.body;

    if (!phone_number || !message) {
      return reply.code(400).send({
        status: 'error',
        message: 'Missing required fields: phone_number and message',
      });
    }

    // Removed auth check - will attempt to send regardless
    // if (!isWhatsAppReady) {
    //   return reply.code(503).send({
    //     status: 'error',
    //     message: 'WhatsApp is not ready. Please authenticate using phone-login (POST /login) and then verify (POST /verify).',
    //   });
    // }

    await sendMessage(phone_number, message);

    return reply.code(200).send({
      status: 'success',
      message: 'Message sent successfully',
      phone_number,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in /message endpoint:', error);
    return reply.code(500).send({
      status: 'error',
      message: 'Failed to send message',
      error: String(error),
    });
  }
});

// Force send message endpoint (bypasses ready check - use when WhatsApp is working but not detected)
app.post<{
  Body: {
    phone_number: string;
    message: string;
  };
}>('/force-send', async (request, reply) => {
  try {
    const { phone_number, message } = request.body;

    if (!phone_number || !message) {
      return reply.code(400).send({
        status: 'error',
        message: 'Missing required fields: phone_number and message',
      });
    }

    console.log(`🔧 FORCE-SEND: Attempting to send message to ${phone_number} (bypassing ready check)`);
    
    await sendMessage(phone_number, message);

    return reply.code(200).send({
      status: 'success',
      message: 'Message sent successfully (forced)',
      phone_number,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in /force-send endpoint:', error);
    return reply.code(500).send({
      status: 'error',
      message: 'Failed to send message',
      error: String(error),
    });
  }
});

// Send message with media endpoint
app.post<{
  Body: {
    phone_number: string;
    media_path: string;
    caption?: string;
  };
}>('/message-media', async (request, reply) => {
  try {
    const { phone_number, media_path, caption } = request.body;

    if (!phone_number || !media_path) {
      return reply.code(400).send({
        status: 'error',
        message: 'Missing required fields: phone_number and media_path',
      });
    }

    if (!isWhatsAppReady) {
      return reply.code(503).send({
        status: 'error',
        message: 'WhatsApp is not ready. Please authenticate first.',
      });
    }

    console.log(`📱 Sending media message to ${phone_number}`);
    console.log(`   Media: ${media_path}`);
    if (caption) console.log(`   Caption: ${caption}`);

    await sendMessageWithMedia(phone_number, media_path, caption);

    return reply.code(200).send({
      status: 'success',
      message: 'Media message sent successfully',
      phone_number,
      media_path,
      caption: caption || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in /message-media endpoint:', error);
    return reply.code(500).send({
      status: 'error',
      message: 'Failed to send media message',
      error: String(error),
    });
  }
});

// Upload and send media in one request
app.post('/send-media', async (request, reply) => {
  try {
    const data = await request.file();
    
    if (!data) {
      return reply.code(400).send({
        status: 'error',
        message: 'No file uploaded. Use multipart/form-data with field name "file"'
      });
    }

    // Get phone number and caption from fields
    const fields = data.fields as any;
    const phoneNumber = fields?.phone_number?.value || fields?.phoneNumber?.value;
    const caption = fields?.caption?.value || '';

    if (!phoneNumber) {
      return reply.code(400).send({
        status: 'error',
        message: 'Missing phone_number field'
      });
    }

    // Removed auth check - will attempt to send regardless
    // if (!isWhatsAppReady) {
    //   return reply.code(503).send({
    //     status: 'error',
    //     message: 'WhatsApp is not ready. Please authenticate first.'
    //   });
    // }

    // Save the file with timestamp
    const originalFilename = data.filename;
    const timestamp = Date.now();
    const filename = `${timestamp}-${originalFilename}`;
    const filepath = path.join(DATA_DIR, filename);

    console.log(`📁 Uploading file: ${originalFilename} -> ${filename}`);
    console.log(`📱 Will send to: ${phoneNumber}`);
    if (caption) console.log(`   Caption: ${caption}`);

    // Save the file
    await pipeline(data.file, fs.createWriteStream(filepath));
    console.log(`✅ File saved: ${filepath}`);

    // Send the message with the uploaded file
    await sendMessageWithMedia(phoneNumber, filepath, caption);

    return reply.code(200).send({
      status: 'success',
      message: 'File uploaded and sent successfully',
      phone_number: phoneNumber,
      filename: filename,
      original_filename: originalFilename,
      caption: caption || null,
      file_size: fs.statSync(filepath).size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Upload and send failed:', error);
    return reply.code(500).send({
      status: 'error',
      message: 'Failed to upload and send media',
      error: String(error)
    });
  }
});

// Get QR code endpoint
app.get('/qr', async (request, reply) => {
  try {
    const result = await getQRCode();
    if (result.success) {
      return reply.code(200).send(result);
    } else {
      return reply.code(404).send(result);
    }
  } catch (error) {
    return reply.code(500).send({ 
      status: 'error', 
      message: String(error) 
    });
  }
});

// Status endpoint for authentication
app.get('/status', async (request, reply) => {
  try {
    if (!page) {
      return reply.code(503).send({
        status: 'not_initialized',
        message: 'WhatsApp page not initialized',
      });
    }
    const currentUrl = page.url();
    
    // Check if QR code is available
    let qrAvailable = false;
    try {
      qrAvailable = await page.locator('canvas[aria-label*="QR"], canvas[aria-label*="Scan"]').isVisible({ timeout: 1000 });
    } catch {
      // ignore
    }
    
    // Try to detect if phone-login is available on the page
    let login_hint = 'waiting_login';
    try {
      const body = await page.content();
      if (/phone|link with phone|log in with phone/i.test(body)) {
        login_hint = 'waiting_phone_number';
      }
    } catch {
      // ignore
    }

    return reply.code(200).send({
      status: isWhatsAppReady ? 'authenticated' : (qrAvailable ? 'waiting_qr_scan' : login_hint),
      needs_qr_scan: !isWhatsAppReady && qrAvailable,
      needs_phone_login: !isWhatsAppReady && login_hint === 'waiting_phone_number',
      current_url: currentUrl,
      message: isWhatsAppReady
        ? 'WhatsApp is authenticated and ready'
        : qrAvailable 
          ? 'QR code available. Use GET /qr to retrieve it and scan with WhatsApp mobile app'
          : 'Waiting for login. Use GET /qr for QR code or POST /login for phone number',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return reply.code(500).send({
      status: 'error',
      error: String(error),
    });
  }
});

// HTML endpoint to display QR code in browser
app.get('/qr-page', async (request, reply) => {
  try {
    const result = await getQRCode();
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Login - Scan QR Code</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
      max-width: 500px;
      color: #333;
    }
    h1 {
      margin: 0 0 10px 0;
      color: #25D366;
      font-size: 32px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 16px;
    }
    .qr-container {
      background: white;
      padding: 20px;
      border-radius: 15px;
      display: inline-block;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      margin: 20px 0;
    }
    .qr-container img {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .instructions {
      background: #f0f0f0;
      padding: 20px;
      border-radius: 10px;
      margin-top: 20px;
      text-align: left;
    }
    .instructions ol {
      margin: 10px 0;
      padding-left: 20px;
    }
    .instructions li {
      margin: 10px 0;
      line-height: 1.6;
    }
    .refresh-btn {
      background: #25D366;
      color: white;
      border: none;
      padding: 12px 30px;
      border-radius: 25px;
      font-size: 16px;
      cursor: pointer;
      margin-top: 20px;
      transition: all 0.3s;
    }
    .refresh-btn:hover {
      background: #128C7E;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(37, 211, 102, 0.4);
    }
    .error {
      background: #ff6b6b;
      color: white;
      padding: 20px;
      border-radius: 10px;
      margin-top: 20px;
    }
    .footer {
      margin-top: 20px;
      font-size: 14px;
      color: #666;
    }
    .auto-refresh {
      font-size: 12px;
      color: #999;
      margin-top: 10px;
    }
  </style>
  <script>
    // Auto-refresh QR code every 30 seconds
    setTimeout(() => {
      window.location.reload();
    }, 30000);
  </script>
</head>
<body>
  <div class="container">
    <h1>🔐 WhatsApp Login</h1>
    <div class="subtitle">Scan QR code to authenticate</div>
    
    ${result.success ? `
      <div class="qr-container">
        <img src="${result.qr}" alt="WhatsApp QR Code" />
      </div>
      
      <div class="instructions">
        <strong>📱 How to scan:</strong>
        <ol>
          <li>Open WhatsApp on your phone</li>
          <li>Tap <strong>Menu</strong> or <strong>Settings</strong></li>
          <li>Tap <strong>Linked Devices</strong></li>
          <li>Tap <strong>Link a Device</strong></li>
          <li>Point your phone at this screen to scan the QR code</li>
        </ol>
      </div>
      
      <button class="refresh-btn" onclick="window.location.reload()">🔄 Refresh QR Code</button>
      <div class="auto-refresh">⏱️ Auto-refreshing in 30 seconds...</div>
    ` : `
      <div class="error">
        <h3>❌ ${result.message}</h3>
        <button class="refresh-btn" onclick="window.location.reload()">Try Again</button>
      </div>
    `}
    
    <div class="footer">
      <small>Session will persist after successful login</small>
    </div>
  </div>
</body>
</html>
    `.trim();
    
    return reply.type('text/html').send(html);
  } catch (error) {
    return reply.type('text/html').send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>Error</h1>
          <p>${String(error)}</p>
          <button onclick="window.location.reload()">Retry</button>
        </body>
      </html>
    `);
  }
});

// Direct PNG download of the latest QR code
app.get('/qr-file', async (request, reply) => {
  try {
    const result = await getQRCode();
    if (!result.success || !result.qr) {
      return reply.code(404).send({ status: 'no_qr', message: result.message || 'No QR available' });
    }
    // Strip data URL prefix
    const base64 = (result.qr as string).replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    reply.header('Content-Type', 'image/png');
    // Suggest filename for browsers
    reply.header('Content-Disposition', 'inline; filename="whatsapp_qr.png"');
    return reply.send(buffer);
  } catch (err) {
    return reply.code(500).send({ status: 'error', message: String(err) });
  }
});

// Debug endpoint: return a small portion of the WhatsApp page HTML for debugging selectors
app.get('/dump', async (request, reply) => {
  try {
    if (!page) return reply.code(503).send({ status: 'not_initialized' });
    const q = request.query as any;
    const requestedLen = parseInt(q?.len || q?.length || '10000', 10) || 10000;
    const maxLen = 200000; // safety cap
    const len = Math.min(requestedLen, maxLen);
    const html = await page.content();
    // Return a slice of the HTML; allow larger dumps via ?len= but cap to avoid huge responses
    return reply.code(200).send({ snippet: html.slice(0, len), length: html.length });
  } catch (error) {
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

// Debug endpoint: take screenshot of current WhatsApp page
app.get('/screenshot', async (request, reply) => {
  try {
    if (!page) {
      return reply.code(503).send({ success: false, message: 'WhatsApp not initialized' });
    }
    
    console.log('📸 Taking screenshot of WhatsApp Web page...');
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const base64 = screenshot.toString('base64');
    
    return reply.code(200).send({
      success: true,
      screenshot: `data:image/png;base64,${base64}`,
      message: 'Screenshot captured successfully'
    });
  } catch (error) {
    console.error('❌ Failed to take screenshot:', error);
    return reply.code(500).send({ success: false, message: `Error: ${error}` });
  }
});

// Root endpoint with API documentation
app.get('/', async (request, reply) => {
  return reply.type('text/html').send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp API</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #25D366; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
        .endpoint { margin: 20px 0; padding: 15px; border-left: 4px solid #25D366; background: #f9f9f9; }
      </style>
    </head>
    <body>
      <h1>📱 WhatsApp API</h1>
      <p>Simple REST API for WhatsApp Web automation using Playwright</p>
      
      <div class="endpoint">
        <h3>GET /health</h3>
        <p>Check API and WhatsApp connection status</p>
      </div>
      
      <div class="endpoint">
        <h3>GET /status</h3>
        <p>Get detailed authentication status</p>
      </div>

      <div class="endpoint">
        <h3>POST /login</h3>
        <p>Submit phone number for phone-login. Returns verification code if displayed on screen.</p>
        <pre>{ "phone_number": "918540029641" }</pre>
        <p><strong>Response:</strong> Returns <code>verification_code</code> if WhatsApp displays it. Otherwise, code is sent to your phone.</p>
      </div>

      <div class="endpoint">
        <h3>GET /code</h3>
        <p>Get the current verification code from screen (if visible).</p>
        <p><strong>Use case:</strong> If POST /login didn't return a code, try this endpoint to check if code appeared.</p>
      </div>

      <div class="endpoint">
        <h3>POST /refresh-code</h3>
        <p><strong>NEW:</strong> Refresh/retry if code expired. Resets the verification screen without restarting session.</p>
        <p>After calling this, use POST /login again to get a fresh code.</p>
      </div>

      <div class="endpoint">
        <h3>POST /verify</h3>
        <p><strong>(Optional)</strong> Submit verification code if implementing web-based code entry</p>
        <pre>{ "code": "ABC12345" }</pre>
        <p><strong>Note:</strong> Typically you enter the code on your phone, not via API.</p>
      </div>
      
      <div class="endpoint">
        <h3>POST /message</h3>
        <p>Send a WhatsApp message</p>
        <pre>{
  "phone_number": "919876543210",
  "message": "Hello from API!"
}</pre>
      </div>
      
      <p><strong>Status:</strong> ${isWhatsAppReady ? '✅ Ready' : '⏳ Waiting for phone-login (use /login and /verify)'}</p>
    </body>
    </html>
  `);
});

// Clear session endpoint - force clear all session data and restart
app.post('/clear-session', async (request, reply) => {
  try {
    console.log('🗑️ Clearing session data...');
    
    // Close browser if open
    if (browser) {
      await browser.close();
      browser = null;
      page = null;
    }
    
    // Delete session files
    const profilePath = './data/chrome_profile';
    
    try {
      // Remove specific session-related directories
      const sessionsToDelete = [
        `${profilePath}/Default/IndexedDB`,
        `${profilePath}/Default/Local Storage`,
        `${profilePath}/Default/Session Storage`,
        `${profilePath}/Default/Cookies`,
        `${profilePath}/Default/Service Worker`,
      ];
      
      for (const sessionPath of sessionsToDelete) {
        try {
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`✅ Deleted: ${sessionPath}`);
          }
        } catch (e) {
          console.log(`⚠️ Could not delete ${sessionPath}: ${e}`);
        }
      }
    } catch (e) {
      console.log(`⚠️ Error during session cleanup: ${e}`);
    }
    
    // Restart WhatsApp initialization
    console.log('🔄 Restarting WhatsApp...');
    setTimeout(() => {
      initWhatsApp().catch(console.error);
    }, 2000);
    
    return reply.send({ 
      status: 'success', 
      message: 'Session cleared. WhatsApp will restart in 2 seconds. Visit /qr-page to scan QR code again.' 
    });
  } catch (error) {
    console.error('Error clearing session:', error);
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

// Reload page endpoint - force reload the WhatsApp Web page
app.post('/reload', async (request, reply) => {
  try {
    if (!page) {
      return reply.code(503).send({ status: 'error', message: 'Browser not initialized' });
    }
    
    console.log('🔄 Reloading WhatsApp Web page...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    return reply.send({ 
      status: 'success', 
      message: 'Page reloaded. Check /qr-page or /status' 
    });
  } catch (error) {
    console.error('Error reloading page:', error);
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

// Force recheck authentication status
app.post('/recheck', async (request, reply) => {
  try {
    if (!page) {
      return reply.code(503).send({ status: 'error', message: 'Browser not initialized' });
    }
    
    console.log('🔄 Rechecking authentication status...');
    
    // Wait for chat list to appear (means authenticated)
    try {
      await page.waitForSelector('[data-testid="chat-list"]', { timeout: 5000 });
      console.log('✅ WhatsApp is authenticated!');
      isWhatsAppReady = true;
      return reply.send({ 
        status: 'success', 
        authenticated: true,
        message: 'WhatsApp is authenticated and ready!' 
      });
    } catch {
      console.log('❌ Still not authenticated');
      return reply.send({ 
        status: 'success', 
        authenticated: false,
        message: 'WhatsApp is not authenticated yet. Please wait or scan QR code.' 
      });
    }
  } catch (error) {
    console.error('Error rechecking auth:', error);
    return reply.code(500).send({ status: 'error', message: String(error) });
  }
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  if (browser) {
    console.log('💾 Closing browser and saving session data...');
    try {
      // Give browser time to flush data to disk
      await new Promise(resolve => setTimeout(resolve, 2000));
      await browser.close();
      console.log('✅ Browser closed successfully');
    } catch (e) {
      console.error('⚠️ Error closing browser:', e);
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start server
async function start() {
  try {
    // Initialize WhatsApp in background
    initWhatsApp().catch(console.error);
    
    // Start API server
    await app.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`🚀 API Server running on http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
