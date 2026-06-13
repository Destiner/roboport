import { defineConfig } from 'vocs/config';

export default defineConfig({
  title: 'Roboport',
  description: 'Agents as Code',
  sidebar: [
    { text: 'Overview', link: '/' },
    {
      text: 'Concepts',
      items: [
        { text: 'Sessions', link: '/concepts/sessions' },
        { text: 'Skills', link: '/concepts/skills' },
        { text: 'MCP', link: '/concepts/mcp' },
        { text: 'Triggers', link: '/concepts/triggers' },
        { text: 'Gateways', link: '/concepts/gateways' },
      ],
    },
  ],
});
