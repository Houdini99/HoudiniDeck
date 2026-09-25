import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { takeKeyFromUrl } from './lib/key.ts';

takeKeyFromUrl();

mount(App, { target: document.getElementById('app')! });
