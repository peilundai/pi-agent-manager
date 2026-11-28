/** The largest image, in raw bytes, a user can attach from the picker, a paste or a drop. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Base64 length of an image of `MAX_IMAGE_BYTES`, including padding. */
export const MAX_IMAGE_BASE64_FOR_RAW = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * The longest image `data` the sanitizer keeps for the webview. It is derived from the
 * attachment limit, with a little headroom, so any image the UI accepts survives echoes
 * and snapshot reloads.
 */
export const MAX_SANITIZED_IMAGE_DATA = MAX_IMAGE_BASE64_FOR_RAW + 64 * 1024;

/** Readable form of `MAX_IMAGE_BYTES` for messages. */
export const MAX_IMAGE_LABEL = `${MAX_IMAGE_BYTES / (1024 * 1024)} MB`;
