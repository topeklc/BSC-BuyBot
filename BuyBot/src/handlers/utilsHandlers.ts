import { handleGroupTypeChange } from "../../../DB/queries";


export const groupTypeChangeHandler = async ( msg: any) => {
    try {
    if (msg.migrate_from_chat_id && msg.sender_chat.id) {
        const newGroup = {id: msg.sender_chat.id, name: msg.sender_chat.title, link: '', created_at: new Date(), updated_at: new Date()}
        const oldId = msg.migrate_from_chat_id
        await handleGroupTypeChange(oldId, newGroup);
    }
    return;
}
catch (error) {
    console.error('Error handling group type change:', error);
}

}

export const getRandomInt = (min: number=1, max: number=10000): number => {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};