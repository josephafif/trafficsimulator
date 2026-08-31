import './style.css';
import { App } from './ui/app.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Rotelementet #app saknas');
new App(root);
