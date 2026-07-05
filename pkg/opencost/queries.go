package opencost

const (
	nodeCPUHourlyCostExpr = `max by (node) (node_cpu_hourly_cost)`
	nodeRAMHourlyCostExpr = `max by (node) (node_ram_hourly_cost)`
)
