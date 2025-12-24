let dailySmokeChartInstance = null;

export function renderDailySmokeChart(canvasEl, smokeHistory) {
    if (!canvasEl) return;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    // Define 3-hour intervals and initialize counts for regular and emergency smokes
    const labels = [
        '00:00-02:59', '03:00-05:59', '06:00-08:59', '09:00-11:59',
        '12:00-14:59', '15:00-17:59', '18:00-20:59', '21:00-23:59'
    ];
    const regularSmokesData = new Array(labels.length).fill(0);
    const emergencySmokesData = new Array(labels.length).fill(0);

    // Filter smokes for today and aggregate into 3-hour intervals by type
    const todaySmokes = smokeHistory.filter(smoke => smoke.timestamp >= todayStart);

    todaySmokes.forEach(smoke => {
        const date = new Date(smoke.timestamp);
        const hour = date.getHours();
        const intervalIndex = Math.floor(hour / 3);
        if (intervalIndex >= 0 && intervalIndex < labels.length) {
            if (smoke.type === 'emergency') {
                emergencySmokesData[intervalIndex]++;
            } else {
                regularSmokesData[intervalIndex]++;
            }
        }
    });

    const dailySmokeCtx = canvasEl.getContext('2d');

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                stacked: true, 
                grid: { color: 'rgba(255, 255, 255, 0.1)' },
                ticks: { color: '#cbd5e1' }
            },
            y: {
                stacked: true, 
                beginAtZero: true,
                grid: { color: 'rgba(255, 255, 255, 0.1)' },
                ticks: {
                    color: '#cbd5e1',
                    stepSize: 1, 
                    callback: function(value) {
                        if (Number.isInteger(value)) {
                            return value;
                        }
                        return null; 
                    }
                }
            }
        },
        plugins: {
            legend: {
                display: true, 
                labels: {
                    color: '#cbd5e1' 
                }
            },
            tooltip: {
                callbacks: {
                    label: function(context) {
                        let label = context.dataset.label || '';
                        if (label) {
                            label += ': ';
                        }
                        label += context.raw;
                        return label;
                    }
                }
            }
        }
    }; 

    if (dailySmokeChartInstance) {
        dailySmokeChartInstance.data.labels = labels;
        dailySmokeChartInstance.data.datasets[0].data = regularSmokesData;
        dailySmokeChartInstance.data.datasets[1].data = emergencySmokesData;
        dailySmokeChartInstance.update();
        console.log("[renderDailySmokeChart] Updated existing daily smoke chart instance.");
    } else {
        // Assume Chart is available globally (from CDN)
        if (typeof Chart === 'undefined') {
            console.error("Chart.js library is not loaded.");
            return;
        }

        dailySmokeChartInstance = new Chart(dailySmokeCtx, {
            type: 'bar', 
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Звичайні',
                        data: regularSmokesData,
                        backgroundColor: 'rgba(52, 211, 153, 0.6)', // Emerald-400
                        borderColor: 'rgba(52, 211, 153, 1)',
                        borderWidth: 1,
                        stack: 'Stack 0',
                        borderRadius: 4
                    },
                    {
                        label: 'Поза нормою', 
                        data: emergencySmokesData,
                        backgroundColor: 'rgba(239, 68, 68, 0.6)', // Red-500
                        borderColor: 'rgba(239, 68, 68, 1)',
                        borderWidth: 1,
                        stack: 'Stack 0',
                        borderRadius: 4
                    }
                ]
            },
            options: chartOptions
        });
        console.log("[renderDailySmokeChart] Created new daily smoke chart instance.");
    }
}

export function destroyChart() {
    if (dailySmokeChartInstance) {
        dailySmokeChartInstance.destroy();
        dailySmokeChartInstance = null;
    }
}
