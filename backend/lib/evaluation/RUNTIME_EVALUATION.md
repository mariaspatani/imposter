# Runtime Evaluation System

## Overview

The Runtime Evaluation System provides browser-based testing of participant GitHub submissions. It goes beyond static code analysis by actually running the submitted web applications and testing them in a real browser environment using Puppeteer.

## Features

- **Repository Download & Extraction**: Automatically downloads and extracts GitHub repositories
- **Project Type Detection**: Identifies project types (Vite, Webpack, Node.js, HTML-only)
- **Development Server Startup**: Automatically starts appropriate dev servers for each project type
- **Browser Automation**: Uses Puppeteer to navigate and interact with applications
- **Task-Specific Testing**: Custom DOM tests for each ASTHRA task (Gallery, Food Cart, Fortune Teller)
- **Responsive Design Testing**: Tests layouts across mobile, tablet, and desktop viewports
- **Console Error Collection**: Captures JavaScript console errors during page load
- **Network Error Monitoring**: Tracks failed network requests
- **Screenshot Capture**: Takes screenshots of the running application
- **Graceful Degradation**: Falls back to static-only evaluation if runtime fails

## Architecture

```
RuntimeEvaluator
├── downloadRepository()     # Download & extract GitHub repo
├── detectProjectType()      # Identify Vite/Node/HTML project
├── startDevServer()         # Start appropriate dev server
├── runTaskSpecificTests()   # Run task-specific DOM tests
├── testResponsiveDesign()   # Test multiple viewports
└── captureScreenshot()      # Take base64 screenshot
```

## Environment Variables

Add these to your `.env` file:

```env
# Enable runtime evaluation (default: false for safety)
RUNTIME_EVALUATION_ENABLED=true

# Maximum time for runtime evaluation in milliseconds (default: 25000)
RUNTIME_TIMEOUT_MS=25000

# Temporary workspace directory (default: /tmp)
RUNTIME_WORKSPACE_DIR=/tmp
```

## Project Type Support

### Vite Projects
- Detected via `package.json` with Vite dependencies
- Started with `npm run dev -- --port <port>`
- Automatically detects ready state from server output

### Node.js Projects
- Detected via `package.json` with dev scripts
- Attempts to run `npm run dev` or `npm start`
- Falls back to error if no suitable script found

### HTML-Only Projects
- Detected by presence of `.html` files without `package.json`
- Uses Python's built-in HTTP server: `python -m http.server <port>`
- Requires Python to be available in the runtime environment

## Task-Specific Tests

### Task 1: Gallery
- **gallery_container**: Checks for gallery DOM elements
- **image_count**: Verifies at least 1 image is present
- **layout_structure**: Tests for grid or flex layout usage

### Task 2: Food Cart
- **food_items_count**: Verifies food item/card elements exist
- **price_display**: Checks for price information in the UI
- **cart_button**: Tests for cart/add-to-cart functionality

### Task 3: Fortune Teller
- **crystal_visual**: Checks for crystal ball or visual elements
- **fortune_text**: Verifies fortune-related text content
- **interactive_element**: Tests for interactive buttons/elements

## Responsive Testing

Tests three viewport sizes:
- **Mobile**: 375x667 (iPhone SE)
- **Tablet**: 768x1024 (iPad)
- **Desktop**: 1366x768 (Standard laptop)

## Output Format

The runtime evaluation returns structured evidence:

```javascript
{
  runtime_available: true,
  runtime_mode: 'FULL_RUNTIME',
  page_loaded: true,
  load_time_ms: 1234,
  console_errors: ['Error: missing semicolon'],
  network_errors: ['stylesheet: net::ERR_CONNECTION_REFUSED'],
  dom_assertions: [
    {
      test: 'gallery_container',
      expected: 'exists',
      actual: 'exists',
      result: 'PASS'
    }
  ],
  interaction_tests: [],
  responsive_tests: [
    {
      viewport: 'mobile_375x667',
      expected: 'adapted',
      actual: 'adapted',
      result: 'PASS'
    }
  ],
  screenshots: ['base64_encoded_image'],
  project_type: 'vite',
  server_port: 3000,
  runtime_duration_ms: 5678
}
```

## Graceful Degradation

If runtime evaluation fails or is disabled, the system automatically falls back to static-only evaluation:

```javascript
{
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
}
```

## Deployment Considerations

### Vercel Deployment
Runtime evaluation is **disabled by default** on Vercel because:
- Puppeteer requires additional system dependencies
- Vercel serverless functions have execution time limits
- Browser automation requires more resources than typical serverless functions

To enable runtime evaluation on Vercel, you would need:
1. A Vercel deployment with sufficient resources
2. Puppeteer configured for serverless environments
3. Increased function timeout limits
4. `RUNTIME_EVALUATION_ENABLED=true` in environment variables

### Local Development
Runtime evaluation works well in local development:
1. Install dependencies: `npm install` (includes Puppeteer)
2. Set `RUNTIME_EVALUATION_ENABLED=true` in `.env`
3. Ensure Python is available for HTML-only projects
4. Start the server: `node server.js`

## Security Considerations

- **Workspace Isolation**: Each evaluation runs in a temporary workspace that is cleaned up after completion
- **Path Traversal Protection**: Repository extraction uses safe path handling
- **Port Selection**: Dynamic port selection avoids conflicts
- **Timeout Protection**: Evaluations are time-limited to prevent hanging
- **Process Cleanup**: Child processes are forcefully terminated after timeout

## Troubleshooting

### Puppeteer Installation Issues
```bash
# If Puppeteer fails to install, try:
npm install puppeteer --ignore-scripts
# Or use the lightweight version:
npm install puppeteer-core
```

### Python Not Found
For HTML-only projects, Python is required. Install Python 3 and ensure it's in your PATH.

### Port Conflicts
The system automatically finds available ports, but if you encounter issues:
- Check that ports 3000-3010 are available
- Set `RUNTIME_WORKSPACE_DIR` to a writable directory

### Memory Issues
Runtime evaluation can be memory-intensive. For systems with limited RAM:
- Reduce `RUNTIME_TIMEOUT_MS` to fail faster
- Consider disabling runtime evaluation: `RUNTIME_EVALUATION_ENABLED=false`

## Future Enhancements

Potential improvements for the runtime evaluation system:

1. **More Task Tests**: Add comprehensive tests for additional tasks
2. **Interaction Testing**: Implement actual click/interaction testing
3. **Performance Metrics**: Add Lighthouse-style performance scoring
4. **Accessibility Testing**: Integrate accessibility checks
5. **Multi-Browser Testing**: Test in Chrome, Firefox, Safari
6. **Screenshot Comparison**: Compare screenshots against reference designs
7. **Console Log Analysis**: Parse and categorize console warnings/errors
8. **Network Timing**: Measure API call performance and timing

## Integration with AI Evaluation

Runtime evidence is automatically integrated into the AI evaluation pipeline:

1. Runtime tests run first (if enabled)
2. Evidence is passed to Groq AI provider
3. AI uses runtime evidence to score more accurately
4. Failed runtime tests result in lower scores for those criteria
5. Runtime-unavailable submissions fall back to static analysis

This hybrid approach provides the best of both worlds: comprehensive runtime testing when available, with reliable static analysis as a fallback.