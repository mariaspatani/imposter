'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Environment configuration
const RUNTIME_ENABLED = process.env.RUNTIME_EVALUATION_ENABLED === 'true';
const RUNTIME_TIMEOUT_MS = Number(process.env.RUNTIME_TIMEOUT_MS) || 25000; // 25s default for Vercel
const WORKSPACE_DIR = process.env.RUNTIME_WORKSPACE_DIR || '/tmp';

/**
 * Safe runtime evaluator for participant submissions.
 * Gracefully degrades to static-only when runtime is unavailable or fails.
 */
class RuntimeEvaluator {
  constructor() {
    this.available = false;
    this.puppeteer = null;
    
    // Try to initialize Puppeteer only if runtime is enabled
    if (RUNTIME_ENABLED) {
      this._initializePuppeteer().catch(() => {
        console.warn('[Runtime] Puppeteer initialization failed - runtime evaluation unavailable');
      });
    }
  }

  async _initializePuppeteer() {
    try {
      // Dynamic import to avoid requiring Puppeteer if not installed
      const puppeteer = require('puppeteer');
      this.puppeteer = puppeteer;
      this.available = true;
      console.log('[Runtime] Puppeteer initialized successfully');
    } catch (err) {
      this.available = false;
      console.warn('[Runtime] Puppeteer not available:', err.message);
    }
  }

  /**
   * Check if runtime evaluation is available
   */
  isAvailable() {
    return RUNTIME_ENABLED && this.available;
  }

  /**
   * Evaluate a participant repository with runtime tests
   * Returns structured evidence or static-only fallback
   * SECURITY: Never logs or includes secret objectives in output
   */
  async evaluate({ assignment, sourceCode }) {
    const startTime = Date.now();
    
    // If runtime is not available, return static-only result immediately
    if (!this.isAvailable()) {
      return {
        runtime_available: false,
        runtime_mode: 'STATIC_ONLY',
        page_loaded: false,
        console_errors: [],
        network_errors: [],
        dom_assertions: [],
        interaction_tests: [],
        responsive_tests: [],
        runtime_duration_ms: 0,
        fallback_reason: 'Runtime evaluation disabled or Puppeteer unavailable'
      };
    }

    let browser = null;
    let page = null;
    let workspaceDir = null;

    try {
      // Create temporary workspace
      workspaceDir = path.join(WORKSPACE_DIR, `eval_${assignment.participant_id}_${Date.now()}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      // Timeout wrapper for entire evaluation
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Runtime evaluation timeout')), RUNTIME_TIMEOUT_MS);
      });

      const evaluationPromise = this._runEvaluation({
        assignment,
        sourceCode,
        workspaceDir
      });

      const result = await Promise.race([evaluationPromise, timeoutPromise]);

      return {
        ...result,
        runtime_available: true,
        runtime_mode: 'FULL_RUNTIME',
        runtime_duration_ms: Date.now() - startTime
      };

    } catch (err) {
      console.error('[Runtime] Evaluation failed:', err.message);
      
      return {
        runtime_available: true,
        runtime_mode: 'FAILED',
        page_loaded: false,
        console_errors: [`Runtime evaluation failed: ${err.message}`],
        network_errors: [],
        dom_assertions: [],
        interaction_tests: [],
        responsive_tests: [],
        runtime_duration_ms: Date.now() - startTime,
        fallback_reason: err.message
      };
    } finally {
      // Cleanup
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      if (workspaceDir) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          console.warn('[Runtime] Workspace cleanup failed:', cleanupErr.message);
        }
      }
    }
  }

  /**
   * Internal evaluation logic with browser automation
   * SECURITY: All assignment data is scrubbed of secrets before use
   */
  async _runEvaluation({ assignment, workspaceDir }) {
    // SECURITY: Create safe copy without any secret fields
    const safeAssignment = {
      ...assignment,
      secret_objective: undefined,
      person4_secret: undefined
    };
    
    const githubRepo = safeAssignment.github_repo;
    const startTime = Date.now();
    
    // Step 1: Download and extract repository
    console.log('[Runtime] Downloading repository for participant:', safeAssignment.participant_id);
    const repoPath = await this._downloadRepository(githubRepo, workspaceDir);
    
    // Step 2: Detect project type
    console.log('[Runtime] Detecting project type...');
    const projectType = await this._detectProjectType(repoPath);
    console.log('[Runtime] Project type detected:', projectType);
    
    // Step 3: Start development server
    console.log('[Runtime] Starting development server...');
    const serverInfo = await this._startDevServer(repoPath, projectType);
    console.log('[Runtime] Server started on port:', serverInfo.port);
    
    // Step 4: Launch browser
    const browser = await this.puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport for responsive testing
    await page.setViewport({ width: 1366, height: 768 });

    // Console error collection
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Network error collection
    const networkErrors = [];
    page.on('requestfailed', request => {
      networkErrors.push(`${request.resourceType()}: ${request.failure().errorText}`);
    });

    // Step 5: Navigate to application
    const appUrl = `http://localhost:${serverInfo.port}`;
    console.log('[Runtime] Navigating to:', appUrl);
    
    try {
      await page.goto(appUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    } catch (navErr) {
      console.warn('[Runtime] Navigation timeout or error:', navErr.message);
      // Continue anyway - we might still get partial results
    }

    const loadTime = Date.now() - startTime;
    const pageLoaded = consoleErrors.length === 0 || !consoleErrors.some(e => e.includes('Failed to load'));

    // Step 6: Run task-specific tests
    console.log('[Runtime] Running task-specific tests for task:', safeAssignment.task_number);
    const testResults = await this._runTaskSpecificTests(page, safeAssignment.task_number);
    
    // Step 7: Capture screenshot
    let screenshot = null;
    try {
      screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    } catch (screenshotErr) {
      console.warn('[Runtime] Screenshot capture failed:', screenshotErr.message);
    }

    // Step 8: Cleanup server
    if (serverInfo.kill) {
      serverInfo.kill();
      console.log('[Runtime] Development server stopped');
    }

    await browser.close();

    return {
      page_loaded: pageLoaded,
      load_time_ms: loadTime,
      console_errors: consoleErrors,
      network_errors: networkErrors,
      dom_assertions: testResults.domAssertions,
      interaction_tests: testResults.interactionTests,
      responsive_tests: testResults.responsiveTests,
      screenshots: screenshot ? [screenshot] : [],
      project_type: projectType,
      server_port: serverInfo.port
    };
  }

  /**
   * Download and extract GitHub repository
   */
  async _downloadRepository(githubUrl, workspaceDir) {
    const axios = require('axios');
    const AdmZip = require('adm-zip');
    const fs = require('fs');
    const path = require('path');

    const clean = String(githubUrl || '').trim().replace(/\/$/, '');
    const urls = [
      `${clean}/archive/refs/heads/main.zip`,
      `${clean}/archive/refs/heads/master.zip`
    ];

    let zipBuffer = null;
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 30 * 1024 * 1024,
          headers: {
            'User-Agent': 'AshtaImposterRuntimeEvaluator/1.0',
            ...(process.env.GITHUB_TOKEN
              ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
              : {})
          }
        });
        zipBuffer = Buffer.from(response.data);
        break;
      } catch (err) {
        console.warn('[Runtime] Failed to download from', url, ':', err.message);
      }
    }

    if (!zipBuffer) {
      throw new Error('Failed to download repository from GitHub');
    }

    // Extract zip
    const zip = new AdmZip(zipBuffer);
    const extractPath = path.join(workspaceDir, 'repo');
    fs.mkdirSync(extractPath, { recursive: true });
    zip.extractAllTo(extractPath, true);

    // Find the actual project directory (GitHub creates a -main or -master folder)
    const entries = fs.readdirSync(extractPath);
    const projectDir = entries.find(e => e.endsWith('-main') || e.endsWith('-master')) || entries[0];
    
    return path.join(extractPath, projectDir);
  }

  /**
   * Detect project type from repository structure
   */
  async _detectProjectType(repoPath) {
    const fs = require('fs');
    const path = require('path');

    // Check for package.json (Node.js project)
    const packageJsonPath = path.join(repoPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.devDependencies?.vite || packageJson.dependencies?.vite) {
          return 'vite';
        }
        if (packageJson.devDependencies?.webpack || packageJson.dependencies?.webpack) {
          return 'webpack';
        }
        if (packageJson.scripts?.dev || packageJson.scripts?.start) {
          return 'node';
        }
      } catch (e) {
        console.warn('[Runtime] Failed to parse package.json:', e.message);
      }
    }

    // Check for HTML-only project
    const htmlFiles = fs.readdirSync(repoPath).filter(f => f.endsWith('.html') || f.endsWith('.htm'));
    if (htmlFiles.length > 0) {
      return 'html';
    }

    // Default to unknown
    return 'unknown';
  }

  /**
   * Start development server based on project type
   */
  async _startDevServer(repoPath, projectType) {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    // Find an available port
    const port = await this._findAvailablePort();
    
    let serverProcess = null;
    let startupTimeout = null;
    let ready = false;

    try {
      switch (projectType) {
        case 'vite':
          console.log('[Runtime] Starting Vite dev server...');
          serverProcess = spawn('npm', ['run', 'dev', '--', '--port', port.toString()], {
            cwd: repoPath,
            stdio: 'pipe',
            shell: true
          });
          break;

        case 'node':
          console.log('[Runtime] Starting Node dev server...');
          // Try common dev scripts
          const packageJsonPath = path.join(repoPath, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const devScript = packageJson.scripts?.dev || packageJson.scripts?.start;
            if (devScript) {
              serverProcess = spawn('npm', ['run', devScript.split(' ')[0]], {
                cwd: repoPath,
                stdio: 'pipe',
                shell: true
              });
            }
          }
          if (!serverProcess) {
            throw new Error('No dev script found in package.json');
          }
          break;

        case 'html':
          console.log('[Runtime] Starting simple HTTP server for HTML...');
          // Use Python's built-in HTTP server
          serverProcess = spawn('python', ['-m', 'http.server', port.toString()], {
            cwd: repoPath,
            stdio: 'pipe'
          });
          break;

        default:
          throw new Error(`Unsupported project type: ${projectType}`);
      }

      if (!serverProcess) {
        throw new Error('Failed to start development server');
      }

      // Wait for server to be ready
      const readyPromise = new Promise((resolve, reject) => {
        startupTimeout = setTimeout(() => {
          reject(new Error('Server startup timeout'));
        }, 10000);

        serverProcess.stdout.on('data', (data) => {
          const output = data.toString();
          console.log('[Runtime Server]', output);
          if (output.includes('ready') || output.includes('listening') || output.includes('Local:') || output.includes('localhost')) {
            clearTimeout(startupTimeout);
            ready = true;
            resolve();
          }
        });

        serverProcess.stderr.on('data', (data) => {
          console.error('[Runtime Server Error]', data.toString());
        });

        serverProcess.on('error', (err) => {
          clearTimeout(startupTimeout);
          reject(err);
        });

        // Also check port availability after a short delay
        setTimeout(async () => {
          try {
            await this._checkPortAvailable(port);
            if (!ready) {
              clearTimeout(startupTimeout);
              ready = true;
              resolve();
            }
          } catch (portErr) {
            if (!ready) {
              clearTimeout(startupTimeout);
              reject(portErr);
            }
          }
        }, 3000);
      });

      await readyPromise;
      console.log('[Runtime] Server is ready on port', port);

      return {
        port,
        kill: () => {
          if (serverProcess) {
            serverProcess.kill('SIGTERM');
            // Force kill after 2 seconds
            setTimeout(() => {
              try {
                serverProcess.kill('SIGKILL');
              } catch (e) {}
            }, 2000);
          }
        }
      };

    } catch (err) {
      if (serverProcess) {
        serverProcess.kill();
      }
      if (startupTimeout) {
        clearTimeout(startupTimeout);
      }
      console.error('[Runtime] Failed to start server:', err.message);
      throw err;
    }
  }

  /**
   * Find an available port starting from a base port
   */
  async _findAvailablePort(startPort = 3000) {
    const net = require('net');
    
    return new Promise((resolve) => {
      const server = net.createServer();
      
      server.listen(startPort, () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      
      server.on('error', () => {
        // Port is in use, try next one
        resolve(this._findAvailablePort(startPort + 1));
      });
    });
  }

  /**
   * Check if a port is available
   */
  async _checkPortAvailable(port) {
    const net = require('net');
    
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
      
      server.on('error', () => {
        reject(new Error(`Port ${port} is not available`));
      });
    });
  }

  /**
   * Run task-specific DOM and interaction tests
   */
  async _runTaskSpecificTests(page, taskNumber) {
    const domAssertions = [];
    const interactionTests = [];
    const responsiveTests = [];

    try {
      switch (taskNumber) {
        case 1:
          // Task 1: Gallery tests
          await this._testGalleryTask(page, domAssertions, interactionTests);
          break;
        case 2:
          // Task 2: Food cart tests
          await this._testFoodCartTask(page, domAssertions, interactionTests);
          break;
        case 3:
          // Task 3: Fortune teller tests
          await this._testFortuneTellerTask(page, domAssertions, interactionTests);
          break;
        default:
          domAssertions.push({
            test: 'unknown_task',
            expected: 'known_task',
            actual: 'task_' + taskNumber,
            result: 'SKIPPED',
            note: 'No tests defined for this task number'
          });
      }

      // Run responsive tests
      await this._testResponsiveDesign(page, responsiveTests);

    } catch (testErr) {
      console.error('[Runtime] Task-specific tests failed:', testErr.message);
      domAssertions.push({
        test: 'test_execution',
        expected: 'completed',
        actual: 'failed',
        result: 'ERROR',
        note: testErr.message
      });
    }

    return { domAssertions, interactionTests, responsiveTests };
  }

  /**
   * Test Task 1: Gallery implementation
   */
  async _testGalleryTask(page, domAssertions, interactionTests) {
    try {
      // Check for gallery container
      const galleryExists = await page.evaluate(() => {
        const gallery = document.querySelector('[class*="gallery"], [id*="gallery"], .gallery, #gallery');
        return !!gallery;
      });
      
      domAssertions.push({
        test: 'gallery_container',
        expected: 'exists',
        actual: galleryExists ? 'exists' : 'not_found',
        result: galleryExists ? 'PASS' : 'FAIL'
      });

      // Check for images
      const imageCount = await page.evaluate(() => {
        const images = document.querySelectorAll('img');
        return images.length;
      });
      
      domAssertions.push({
        test: 'image_count',
        expected: '>=1',
        actual: imageCount.toString(),
        result: imageCount >= 1 ? 'PASS' : 'FAIL'
      });

      // Check for grid/flex layout
      const hasGridLayout = await page.evaluate(() => {
        const element = document.querySelector('*');
        if (!element) return false;
        const styles = window.getComputedStyle(element);
        return styles.display === 'grid' || styles.display === 'flex';
      });
      
      domAssertions.push({
        test: 'layout_structure',
        expected: 'grid_or_flex',
        actual: hasGridLayout ? 'grid_or_flex' : 'unknown',
        result: hasGridLayout ? 'PASS' : 'WARN'
      });

    } catch (err) {
      domAssertions.push({
        test: 'gallery_task',
        expected: 'completed',
        actual: 'error',
        result: 'ERROR',
        note: err.message
      });
    }
  }

  /**
   * Test Task 2: Food cart implementation
   */
  async _testFoodCartTask(page, domAssertions, interactionTests) {
    try {
      // Check for food items/cards
      const foodItems = await page.evaluate(() => {
        const items = document.querySelectorAll('[class*="food"], [class*="item"], [class*="card"], .food-item, .card');
        return items.length;
      });
      
      domAssertions.push({
        test: 'food_items_count',
        expected: '>=1',
        actual: foodItems.toString(),
        result: foodItems >= 1 ? 'PASS' : 'FAIL'
      });

      // Check for prices
      const hasPrices = await page.evaluate(() => {
        const text = document.body.innerText;
        return /\$|price|cost/i.test(text);
      });
      
      domAssertions.push({
        test: 'price_display',
        expected: 'present',
        actual: hasPrices ? 'present' : 'not_found',
        result: hasPrices ? 'PASS' : 'FAIL'
      });

      // Check for cart functionality
      const hasCartButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.some(btn => /cart|add|buy/i.test(btn.textContent));
      });
      
      domAssertions.push({
        test: 'cart_button',
        expected: 'exists',
        actual: hasCartButton ? 'exists' : 'not_found',
        result: hasCartButton ? 'PASS' : 'WARN'
      });

    } catch (err) {
      domAssertions.push({
        test: 'food_cart_task',
        expected: 'completed',
        actual: 'error',
        result: 'ERROR',
        note: err.message
      });
    }
  }

  /**
   * Test Task 3: Fortune teller implementation
   */
  async _testFortuneTellerTask(page, domAssertions, interactionTests) {
    try {
      // Check for crystal ball or visual element
      const hasVisual = await page.evaluate(() => {
        const visual = document.querySelector('[class*="crystal"], [class*="ball"], [class*="fortune"], .crystal-ball, .fortune');
        return !!visual;
      });
      
      domAssertions.push({
        test: 'crystal_visual',
        expected: 'exists',
        actual: hasVisual ? 'exists' : 'not_found',
        result: hasVisual ? 'PASS' : 'FAIL'
      });

      // Check for fortune text
      const hasFortuneText = await page.evaluate(() => {
        const text = document.body.innerText;
        return /fortune|future|predict/i.test(text);
      });
      
      domAssertions.push({
        test: 'fortune_text',
        expected: 'present',
        actual: hasFortuneText ? 'present' : 'not_found',
        result: hasFortuneText ? 'PASS' : 'FAIL'
      });

      // Check for interactive element
      const hasInteractive = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        const clickable = document.querySelectorAll('[onclick], [class*="click"]');
        return buttons.length > 0 || clickable.length > 0;
      });
      
      domAssertions.push({
        test: 'interactive_element',
        expected: 'exists',
        actual: hasInteractive ? 'exists' : 'not_found',
        result: hasInteractive ? 'PASS' : 'WARN'
      });

    } catch (err) {
      domAssertions.push({
        test: 'fortune_teller_task',
        expected: 'completed',
        actual: 'error',
        result: 'ERROR',
        note: err.message
      });
    }
  }

  /**
   * Test responsive design
   */
  async _testResponsiveDesign(page, responsiveTests) {
    try {
      // Test mobile viewport
      await page.setViewport({ width: 375, height: 667 });
      const mobileLayout = await page.evaluate(() => {
        const body = document.body;
        return body.offsetWidth <= 375;
      });
      
      responsiveTests.push({
        viewport: 'mobile_375x667',
        expected: 'adapted',
        actual: mobileLayout ? 'adapted' : 'not_adapted',
        result: mobileLayout ? 'PASS' : 'WARN'
      });

      // Test tablet viewport
      await page.setViewport({ width: 768, height: 1024 });
      const tabletLayout = await page.evaluate(() => {
        const body = document.body;
        return body.offsetWidth <= 768;
      });
      
      responsiveTests.push({
        viewport: 'tablet_768x1024',
        expected: 'adapted',
        actual: tabletLayout ? 'adapted' : 'not_adapted',
        result: tabletLayout ? 'PASS' : 'WARN'
      });

      // Reset to desktop
      await page.setViewport({ width: 1366, height: 768 });

    } catch (err) {
      responsiveTests.push({
        viewport: 'responsive_test',
        expected: 'completed',
        actual: 'error',
        result: 'ERROR',
        note: err.message
      });
    }
  }
}

// Singleton instance
let instance = null;

function getRuntimeEvaluator() {
  if (!instance) {
    instance = new RuntimeEvaluator();
  }
  return instance;
}

module.exports = {
  RuntimeEvaluator,
  getRuntimeEvaluator
};