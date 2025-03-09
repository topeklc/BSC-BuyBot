export const getHolderIncrease = (holderBalance: number, boughtAmount: number): string => {
    const previousBalance = holderBalance - boughtAmount;
    console.log('previousBalance', previousBalance);
    console.log('holderBalance', holderBalance);
    console.log('boughtAmount', boughtAmount);
    let holderIncrease = '';
    if (previousBalance >= 0 && holderBalance === boughtAmount) {
        holderIncrease = 'New Holder!';
    } else if (previousBalance > 0) {
        const percentageIncrease = boughtAmount / previousBalance * 100;
        // Only show percentage if it's above 1%
        if (percentageIncrease > 1) {
            holderIncrease = `+${percentageIncrease.toFixed(2)}%`;
        }
    }
    console.log('holderIncrease', holderIncrease);
    return holderIncrease;
}