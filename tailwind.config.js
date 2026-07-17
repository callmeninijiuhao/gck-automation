/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            fontFamily: {
                sans: ['"Open Sans"', 'sans-serif'],
            },
            colors: {
                pubmatic: {
                    blue: '#0072CE', navy: '#002E5D', teal: '#00A5E0', gray: '#F5F7FA', border: '#E0E0E0', text: '#333333', lightBlue: '#F0F7FF',
                }
            }
        },
    },
    plugins: [],
}
