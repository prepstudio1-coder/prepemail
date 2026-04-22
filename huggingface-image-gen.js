// huggingface-image-gen.js - AI Image Generation via backend proxy
// Routes through server.js to avoid CORS restrictions on the HF Inference API
import { huggingFaceConfig, apiConfig } from "./config.js";

/**
 * Generate an image from text using Hugging Face Stable Diffusion (via proxy)
 * @param {string} prompt - The text description for image generation
 * @returns {Promise<Blob>} - Generated image as Blob
 */
export async function generateStoryboardImage(prompt) {
    const hfToken = huggingFaceConfig.token;

    if (!hfToken || hfToken === 'your_huggingface_token_here') {
        throw new Error('Hugging Face API token is not configured.');
    }

    // When running locally, use local server to avoid hitting undeployed changes
    const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
    const baseUrl = isLocal ? 'http://localhost:3000' : apiConfig.baseUrl;
    const proxyUrl = `${baseUrl}/api/ai/generate-image`;

    const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.message || `Failed to generate image (${response.status})`);
    }

    // Convert base64 back to Blob
    const byteCharacters = atob(data.image);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    return new Blob([byteNumbers], { type: data.contentType || 'image/jpeg' });
}

/**
 * Build a cinematic prompt from panel/shot data
 * @param {Object} data - Panel or shot data object
 * @returns {string} - Formatted prompt for image generation
 */
export function createPromptFromPanelData(data) {
    const parts = [];

    const desc = data.note || data.description;
    if (desc) parts.push(desc);

    const action = data.actionNotes || data.cameraMovement;
    if (action) parts.push(action);

    if (data.type && data.type !== 'panel' && data.type !== 'placeholder') {
        parts.push(`${data.type} shot`);
    }

    const dialogue = data.dialogue || data.notes;
    if (dialogue && dialogue.length < 80) {
        parts.push(`Scene: ${dialogue}`);
    }

    parts.push('cinematic storyboard frame, professional film production, detailed scene composition, dramatic lighting');

    return parts.join('. ');
}

/**
 * Convert a Blob to a File object ready for upload
 * @param {Blob} blob - Image blob from generation
 * @param {string} filename - Desired filename
 * @returns {File}
 */
export function blobToFile(blob, filename = 'ai-generated-storyboard.jpg') {
    return new File([blob], filename, { type: blob.type || 'image/jpeg' });
}
