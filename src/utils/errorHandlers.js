/**
 * Global error handlers for the Discord bot
 */

import logger from './logger.js';

/**
 * Handle uncaught exceptions. `onFatal(error)` runs instead of exiting outright on a
 * fatal one, so the caller can clean up (refunds, connections) and exit itself.
 * Shutdown signals are handled in index.js.
 */
export function setupGlobalErrorHandlers({ onFatal } = {}) {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    if (error.code === 10062) {
      // Unknown interaction - log but don't crash
      console.log('[ERROR] Expired interaction attempt:', error.message);
      return;
    }
    
    logger.error('Uncaught exception:', error);
    console.error('[RAPHAEL] Uncaught exception:', error);
    
    // Log the full stack trace for debugging
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
    
    // Don't exit for known Discord API errors
    const knownErrors = ['Unknown interaction', 'Unknown message', 'Unknown channel'];
    const isKnownError = knownErrors.some(known => error.message?.includes(known));
    
    if (!isKnownError) {
      console.error('[RAPHAEL] Process will exit due to uncaught exception');
      if (onFatal) onFatal(error);
      else process.exit(1);
    }
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    // Log but don't crash for Discord API errors
    if (reason?.code === 10062 || reason?.message?.includes('Unknown interaction')) {
      console.log('[ERROR] Unhandled interaction rejection:', reason.message);
      return;
    }
    
    logger.error('Unhandled promise rejection:', reason);
    console.error('[RAPHAEL] Unhandled promise rejection at:', promise, 'reason:', reason);
    
    // Log the stack if available
    if (reason?.stack) {
      console.error('Stack:', reason.stack);
    }
  });

  console.log('[RAPHAEL] Global error handlers initialized');
}

/**
 * Wrapper for database operations to handle MongoDB connection issues
 */
export async function safeDbOperation(operation, fallback = null) {
  try {
    return await operation();
  } catch (error) {
    if (error.name === 'MongoServerSelectionError' || 
        error.message?.includes('ENOTFOUND') ||
        error.message?.includes('getaddrinfo')) {
      console.log('[DB] MongoDB connection unavailable, operation skipped');
      return fallback;
    }
    
    // Re-throw other errors
    throw error;
  }
}

/**
 * Wrapper for Discord API calls to handle rate limits and unknown interactions
 */
export async function safeDiscordOperation(operation, context = 'Discord operation') {
  try {
    return await operation();
  } catch (error) {
    // Handle common Discord API errors gracefully
    if (error.code === 10062) {
      console.log(`[Discord] ${context}: Interaction expired`);
      return null;
    }
    
    if (error.code === 50013) {
      console.log(`[Discord] ${context}: Missing permissions`);
      return null;
    }
    
    if (error.code === 50001) {
      console.log(`[Discord] ${context}: Missing access`);
      return null;
    }
    
    if (error.httpStatus === 429) {
      console.log(`[Discord] ${context}: Rate limited, retrying...`);
      // Simple retry after rate limit
      await new Promise(resolve => setTimeout(resolve, error.retryAfter || 1000));
      try {
        return await operation();
      } catch (retryError) {
        console.log(`[Discord] ${context}: Retry failed`);
        return null;
      }
    }
    
    // Log unknown errors but don't crash
    console.error(`[Discord] ${context}: Unknown error:`, error.message);
    return null;
  }
}

/**
 * Enhanced interaction response handler
 */
export async function safeInteractionReply(interaction, options, context = 'Interaction') {
  return safeDiscordOperation(async () => {
    // Check if interaction is still valid
    if (!interaction || !interaction.isRepliable()) {
      console.log(`[${context}] Interaction not repliable`);
      return null;
    }
    
    // Choose appropriate response method
    if (interaction.replied) {
      return await interaction.editReply(options);
    } else if (interaction.deferred) {
      return await interaction.editReply(options);
    } else {
      return await interaction.reply(options);
    }
  }, context);
}