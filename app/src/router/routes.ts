import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/overlay' },
  { path: '/overlay', component: () => import('pages/OverlayPage.vue') },
  { path: '/settings', component: () => import('pages/SettingsPage.vue') },
  { path: '/test', component: () => import('pages/TestModePage.vue') },
  { path: '/:catchAll(.*)*', component: () => import('pages/ErrorNotFound.vue') },
];

export default routes;
