import { createApp } from './app.js';
const app = createApp();
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`Dynastytrust API listening on ${port}`));
