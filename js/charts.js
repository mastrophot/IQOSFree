let currentChartInstance = null;

export function renderSmokeChart(canvasEl, smokeHistory, period = 'day', mode = 'sticks', settings = {}) {
    if (!canvasEl) return;

    const ctx = canvasEl.getContext('2d');
    const { labels, regularData, emergencyData, rawTotals } = processData(smokeHistory, period);

    // Calculate Values based on Mode
    let dataset1, dataset2;
    let unitLabel = '';
    
    // Calculate limits and prices
    const limit = settings.desiredDailySticks || 10;
    const pricePerSick = (settings.packPrice || 100) / (settings.packSize || 20);

    if (mode === 'money') {
        unitLabel = ' грн';
        dataset1 = regularData.map(v => (v * pricePerSick).toFixed(1));
        dataset2 = emergencyData.map(v => (v * pricePerSick).toFixed(1));
    } else {
        unitLabel = ' шт';
        dataset1 = regularData;
        dataset2 = emergencyData;
    }

    // Dynamic Coloring (Green vs Red based on limit)
    // Only apply strict limit coloring for Week/All views where bars represent whole days
    const isDailyView = period === 'day';
    
    const getBarColor = (val, type) => {
        if (mode === 'money') return type === 'emergency' ? '#ef4444' : '#10b981'; // Fixed colors for money
        
        // For Sticks Mode
        if (type === 'emergency') return '#ef4444'; // Always Red
        
        if (!isDailyView) {
            // Week/All views: Compare total (reg + em) against Daily Limit
            // Note: Since we are coloring split datasets, we need context. 
            // Simplified: If bar value > limit, it's red.
            // Actually, we need to sum reg+em to know if day failed.
            // Chart.js scriptable options allow access to context.
            // For simplicity in this iteration: Green for Regular, Red for Emergency. 
            // "Goal Line" will suffice for visual limit.
             return '#10b981';
        }
        return '#10b981';
    };

    const annotations = {};
    if (!isDailyView && mode === 'sticks') {
        // Add Goal Line
        annotations.goalLine = {
            type: 'line',
            yMin: limit,
            yMax: limit,
            borderColor: 'rgba(255, 255, 255, 0.3)',
            borderWidth: 1,
            borderDash: [5, 5],
            label: {
                display: true,
                content: 'Ліміт',
                position: 'end',
                color: 'rgba(255, 255, 255, 0.5)',
                font: { size: 9 }
            }
        };
    }

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                stacked: true,
                grid: { display: false },
                ticks: { color: '#64748b', font: { size: 9, family: 'Inter' } }
            },
            y: {
                stacked: true,
                beginAtZero: true,
                border: { display: false },
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: {
                    color: '#64748b',
                    font: { size: 9, family: 'Inter' },
                    callback: (value) => value + (mode === 'money' ? '' : '') // Minimal Y-axis labels
                }
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#f8fafc',
                bodyColor: '#cbd5e1',
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                    label: (context) => {
                        let label = context.dataset.label || '';
                        if (label) label += ': ';
                        label += context.raw + unitLabel;
                        return label;
                    }
                }
            },
            annotation: {
                annotations: annotations
            }
        },
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 400 }
    };

    if (currentChartInstance) {
        currentChartInstance.options = chartOptions; // Update options (for annotations)
        currentChartInstance.data.labels = labels;
        currentChartInstance.data.datasets[0].data = dataset1;
        currentChartInstance.data.datasets[1].data = dataset2;
        currentChartInstance.update();
    } else {
        if (typeof Chart === 'undefined') {
            console.error("Chart.js not loaded.");
            return;
        }

        // Check if Annotation plugin is available (might need to load it)
        // For now, we implemented 'annotations' object but if the plugin isn't loaded via CDN, it won't show.
        // We will assume standard Chart.js for now. If user wants line, we might need to draw it manually or safely ignore.
        
        currentChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Звичайні',
                        data: dataset1,
                        backgroundColor: '#10b981', // Emerald-500
                        borderRadius: 3,
                        maxBarThickness: 20
                    },
                    {
                        label: 'Поза нормою',
                        data: dataset2,
                        backgroundColor: '#ef4444', // Red-500
                        borderRadius: 3,
                        maxBarThickness: 20
                    }
                ]
            },
            options: chartOptions
        });
    }
}

function processData(history, period) {
    const now = new Date();
    let labels = [];
    let regularData = [];
    let emergencyData = [];
    // We keep raw totals for heatmaps/insights if needed later
    let rawTotals = []; 

    if (period === 'day') {
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        labels = ['0-3', '3-6', '6-9', '9-12', '12-15', '15-18', '18-21', '21-24'];
        regularData = new Array(8).fill(0);
        emergencyData = new Array(8).fill(0);

        history.filter(s => s.timestamp >= todayStart).forEach(s => {
            const h = new Date(s.timestamp).getHours();
            const idx = Math.floor(h / 3);
            if (s.type === 'emergency') emergencyData[idx]++;
            else regularData[idx]++;
        });

    } else if (period === 'week') {
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const dateStr = d.toLocaleDateString('uk-UA', { weekday: 'short' });
            labels.push(dateStr);
            
            const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
            const endOfDay = startOfDay + 86400000;
            
            let regCount = 0, emCount = 0;
            history.forEach(s => {
                if (s.timestamp >= startOfDay && s.timestamp < endOfDay) {
                    if (s.type === 'emergency') emCount++;
                    else regCount++;
                }
            });
            regularData.push(regCount);
            emergencyData.push(emCount);
        }

    } else if (period === 'all') {
        // Last 6 months
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            labels.push(d.toLocaleDateString('uk-UA', { month: 'short' }));

            const startOfMonth = d.getTime();
            const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();

            let regCount = 0, emCount = 0;
            history.forEach(s => {
                if (s.timestamp >= startOfMonth && s.timestamp < endOfMonth) {
                    if (s.type === 'emergency') emCount++;
                    else regCount++;
                }
            });
            regularData.push(regCount);
            emergencyData.push(emCount);
        }
    }

    return { labels, regularData, emergencyData };
}

export function destroyChart() {
    if (currentChartInstance) {
        currentChartInstance.destroy();
        currentChartInstance = null;
    }
}
