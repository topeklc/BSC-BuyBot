import { Socials } from './messages';

// Keywords that will unset a social link
const UNSET_KEYWORDS = ['del', 'unset'];

interface SocialValidation {
    isValid: (url: string) => boolean;
    example: string;
    normalize: (url: string) => string | null;
}

// Helper functions
const isUnsetCommand = (text: string) => UNSET_KEYWORDS.includes(text.toLowerCase());
const normalizeUrl = (url: string) => url.startsWith('http') ? url : `https://${url}`;

const socialValidations: Record<keyof Socials, SocialValidation> = {
    website: {
        isValid: (url: string) => {
            if (isUnsetCommand(url)) return true;
            return /^(https?:\/\/)?(www\.)?[a-zA-Z0-9.-]+(\.[a-zA-Z]{2,})+/.test(url);
        },
        normalize: (url: string) => {
            if (isUnsetCommand(url)) return null;
            return normalizeUrl(url.startsWith('www.') ? `https://${url}` : url);
        },
        example: 'example.com or www.example.com (or type "del"/"unset" to remove)'
    },
    telegram: {
        isValid: (url: string) => {
            if (isUnsetCommand(url)) return true;
            return /^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\/[a-zA-Z0-9_@+]+$/.test(url);
        },
        normalize: (url: string) => {
            if (isUnsetCommand(url)) return null;
            if (url.startsWith('@')) return `https://t.me/${url.substring(1)}`;
            return normalizeUrl(url.startsWith('www.') ? `https://${url}` : url);
        },
        example: '@groupname or t.me/groupname or t.me/invitecode (or type "del"/"unset" to remove)'
    },
    x: {
        isValid: (url: string) => {
            if (isUnsetCommand(url)) return true;
            return /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+$/.test(url);
        },
        normalize: (url: string) => {
            if (isUnsetCommand(url)) return null;
            return normalizeUrl(url.startsWith('www.') ? `https://${url}` : url);
        },
        example: 'x.com/username  or www.x.com/username (or type "del"/"unset" to remove)'
    },
};

/**
 * Validates a social media URL
 * @param type Type of social media
 * @param url URL to validate
 * @returns Object containing validation result and error message if invalid
 */
export function validateSocialUrl(type: keyof Socials, url: string): { isValid: boolean; error?: string; normalizedUrl?: string | null } {
    const validation = socialValidations[type];
    if (!validation) {
        return { isValid: false, error: 'Unknown social media type' };
    }

    if (!validation.isValid(url)) {
        return {
            isValid: false,
            error: `Invalid ${type} URL. Example format: ${validation.example}`
        };
    }

    return { 
        isValid: true, 
        normalizedUrl: validation.normalize(url)
    };
}
