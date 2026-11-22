import type { SubmittedAnnotation } from '../annotations/annotations';
import type {ChatDraft} from './chatConversations';

export type ChatAnnotationBatch = {
    instruction: string;
    items: readonly SubmittedAnnotation[];
};

export type ChatMessageDetails = {
    documentFile?: string;
    annotationBatch?: ChatAnnotationBatch;
    turnId?:string;
    draft?:ChatDraft;
};

export type Message = ChatMessageDetails & {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
};
export const hello: Message = {
    id: "welcome",
    role: "assistant",
    content: "把还没成形的想法留在这里。\n我们可以一起理大纲、推敲一句话，或者只往下写一小段。",
};
