/**
 * Formats a number to show 3 decimal places after the first non-zero digit
 * @param value The number to format
 * @returns Formatted string
 */
export function formatTokenAmount(value: number): string {
    if (value === 0) return '0';

    // If it's a whole number and greater than or equal to 1
    if (Number.isInteger(value) && value >= 1) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    // If number is greater than 1000, format with commas and up to 3 decimal places
    if (value >= 1000) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
    }

    // Convert to string in normal notation
    const str = Math.abs(value).toString();

    // If number is in scientific notation, convert it to regular notation
    if (str.includes('e')) {
        const [base, exponent] = str.split('e');
        const exp = parseInt(exponent);
        if (exp < 0) {
            // For very small numbers
            const absExp = Math.abs(exp);
            return (value < 0 ? '-' : '') + '0.' + '0'.repeat(absExp - 1) + base.replace('.', '');
        } else {
            // For very large numbers
            return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
        }
    }

    // Find position of first non-zero digit after decimal
    const decimalPos = str.indexOf('.');
    if (decimalPos === -1) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    let firstNonZeroPos = decimalPos + 1;
    while (firstNonZeroPos < str.length && str[firstNonZeroPos] === '0') {
        firstNonZeroPos++;
    }

    // If all decimal places are zero
    if (firstNonZeroPos === str.length) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    // Calculate how many decimal places to show (3 more after first non-zero)
    const placesToShow = firstNonZeroPos - decimalPos + 3;
    return value.toLocaleString('en-US', { maximumFractionDigits: placesToShow });
}

/**
 * Formats a dollar amount with commas for thousands and appropriate decimals
 * @param value The dollar amount to format
 * @returns Formatted string
 */
export function formatDollarAmount(value: number, decimals: boolean = true): string {
    if (Number.isInteger(value) || decimals === false) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
