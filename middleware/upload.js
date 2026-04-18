const multer = require('multer');
const path = require('path');

// Store file in memory temporarily before sending to Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = [
        'audio/mpeg',
        'audio/mp3',
        'audio/mp4',
        'audio/x-m4a',
        'audio/aac',
        'audio/wav',
        'audio/x-wav',
        'audio/ogg',
        'audio/webm', // ✅ important for Flutter
    ];

    const allowedExtensions = [
        '.mp3',
        '.m4a',
        '.wav',
        '.aac',
        '.ogg',
        '.webm',
    ];

    const ext = path.extname(file.originalname).toLowerCase();

    const isMimeValid = allowedMimeTypes.includes(file.mimetype);
    const isExtValid = allowedExtensions.includes(ext);

    if (isMimeValid || isExtValid) {
        return cb(null, true);
    }

    return cb(
        new Error(
            `Only audio files are allowed (MP3, M4A, WAV, AAC, OGG, WEBM). Received: ${file.mimetype}`
        ),
        false
    );
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100 MB max
    },
});

module.exports = upload;