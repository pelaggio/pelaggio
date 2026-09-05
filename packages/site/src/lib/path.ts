export const sitePath = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;
