// Dark Mode Toggle Functionality

// Check for saved theme preference or default to light mode
const currentTheme = localStorage.getItem('theme') || 'light';

// Apply the saved theme on page load
if (currentTheme === 'dark') {
    document.body.classList.add('dark-mode');
}

// Get the toggle button
const themeToggle = document.getElementById('theme-toggle');

// Add click event listener to toggle dark mode
themeToggle.addEventListener('click', () => {
    // Toggle the dark-mode class
    document.body.classList.toggle('dark-mode');
    
    // Determine the current theme after toggle
    const theme = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
    
    // Save the preference to localStorage
    localStorage.setItem('theme', theme);
    
    // Optional: Add a subtle animation feedback
    themeToggle.style.transform = 'rotate(360deg)';
    setTimeout(() => {
        themeToggle.style.transform = '';
    }, 300);
});