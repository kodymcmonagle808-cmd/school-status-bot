export function findPath(graph, startName, endName) {
    let startId = null;
    let endId = null;
    
    // Find room ids by name
    for (const id in graph.nodes) {
        const node = graph.nodes[id];
        if (node.name && node.name.toUpperCase() === startName.toUpperCase()) startId = id;
        if (node.name && node.name.toUpperCase() === endName.toUpperCase()) endId = id;
    }

    if (!startId || !endId) return null;

    const adj = {};
    for (const edge of graph.edges) {
        if (!adj[edge.source]) adj[edge.source] = [];
        if (!adj[edge.target]) adj[edge.target] = [];
        adj[edge.source].push({ neighbor: edge.target, cost: edge.cost });
        adj[edge.target].push({ neighbor: edge.source, cost: edge.cost });
    }
    
    const heuristic = (idA, idB) => {
        const a = graph.nodes[idA];
        const b = graph.nodes[idB];
        return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const openSet = new Set([startId]);
    const cameFrom = {};
    const gScore = {};
    const fScore = {};
    
    for (const id in graph.nodes) {
        gScore[id] = Infinity;
        fScore[id] = Infinity;
    }
    gScore[startId] = 0;
    fScore[startId] = heuristic(startId, endId);

    while (openSet.size > 0) {
        let current = null;
        let lowestF = Infinity;
        for (const id of openSet) {
            if (fScore[id] < lowestF) {
                lowestF = fScore[id];
                current = id;
            }
        }
        
        if (current === endId) {
            const path = [graph.nodes[current]];
            while (cameFrom[current]) {
                current = cameFrom[current];
                path.unshift(graph.nodes[current]);
            }
            return path;
        }
        
        openSet.delete(current);
        
        if (adj[current]) {
            for (const { neighbor, cost } of adj[current]) {
                const tentativeG = gScore[current] + cost;
                if (tentativeG < gScore[neighbor]) {
                    cameFrom[neighbor] = current;
                    gScore[neighbor] = tentativeG;
                    fScore[neighbor] = tentativeG + heuristic(neighbor, endId);
                    if (!openSet.has(neighbor)) {
                        openSet.add(neighbor);
                    }
                }
            }
        }
    }
    
    return null;
}
