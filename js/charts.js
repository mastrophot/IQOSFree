let currentChartInstance = null;

export function renderSmokeChart(canvasEl, smokeHistory, period = 'day') {
    if (!canvasEl) return;

    const ctx = canvasEl.getContext('2d');
    const { labels, regularData, emergencyData } = processData(smokeHistory, period);

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                stacked: true,
                grid: { display: false },
                ticks: { color: '#64748b', font: { size: 10, family: 'Inter' } } // Slate-500
            },
            y: {
                stacked: true,
                beginAtZero: true,
                border: { display: false },
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: {
                    color: '#64748b',
                    font: { size: 10, family: 'Inter' },
                    stepSize: 1,
                    callback: (value) => Number.isInteger(value) ? value : null
                }
            }
        },
        plugins: {
            legend: { display: false }, // Custom legend in UI if needed, or minimal
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.9)', // Slate-900
                titleColor: '#f8fafc',
                bodyColor: '#cbd5e1',
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                    label: (context) => {
                        let label = context.dataset.label || '';
                        if (label) label += ': ';
                        label += context.raw;
                        return label;
                    }
                }
            }
        },
        interaction: {
            mode: 'index',
            intersect: false,
        },
        animation: {
            duration: 500
        }
    };

    if (currentChartInstance) {
        currentChartInstance.data.labels = labels;
        currentChartInstance.data.datasets[0].data = regularData;
        currentChartInstance.data.datasets[1].data = emergencyData;
        currentChartInstance.update();
    } else {
        if (typeof Chart === 'undefined') {
            console.error("Chart.js not loaded.");
            return;
        }

        currentChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Звичайні',
                        data: regularData,
                        backgroundColor: '#10b981', // Emerald-500
                        borderRadius: 4,
                        maxBarThickness: 20
                    },
                    {
                        label: 'Поза нормою',
                        data: emergencyData,
                        backgroundColor: '#ef4444', // Red-500
                        borderRadius: 4,
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

    if (period === 'day') {
        // 3-hour intervals for today
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
        // Last 7 days
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const dateStr = d.toLocaleDateString('uk-UA', { weekday: 'short' }); // Пн, Вт...
            labels.push(dateStr);
            
            const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
            const endOfDay = startOfDay + 86400000;
            
            let regCount = 0;
            let emCount = 0;

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
        // Group by Month (or Day if less than 30 days of data - explicit simplification to grouping by month for now for robustness)
        // Let's do last 6 months for compactness
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthLabel = d.toLocaleDateString('uk-UA', { month: 'short' });
            labels.push(monthLabel);

            const startOfMonth = d.getTime();
            const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();

             let regCount = 0;
            let emCount = 0;

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
