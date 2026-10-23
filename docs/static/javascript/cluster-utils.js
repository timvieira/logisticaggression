// cluster-utils.js
// Shared utilities for cluster color management and calculations

// Standard cluster color palette used across the application
export const CLUSTER_PALETTE = [
  "#f5e45a",
  "#4aa6e2",
  "#f09cbe",
  "#4fb7b0",
  "#f19e6c",
  "#9a8ae0",
  "#7fd0ee",
  "#e8608f",
  "#f7c948",
  "#3d7fd1",
  "#f6bca5",
  "#c9a3e8",
  "#d9e98a",
  "#e58a5a",
  "#b8e0f5",
  "#a8d8c8",
];

// Color for unclustered images
export const UNCLUSTERED_COLOR = "#5f5e6b";

/**
 * Get the color for a specific cluster based on UMAP points
 * @param {number} cluster - The cluster number (-1 for unclustered)
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {string} - Hex color code for the cluster
 */
export function getClusterColorFromPoints(cluster, umapPoints) {
  if (cluster === -1) {
    return UNCLUSTERED_COLOR;
  }
  
  if (!umapPoints || umapPoints.length === 0) {
    return UNCLUSTERED_COLOR;
  }
  
  // Get all unique clusters and find the index of the target cluster
  const uniqueClusters = [...new Set(umapPoints.map(p => p.cluster))];
  const clusterIdx = uniqueClusters.indexOf(cluster);
  
  if (clusterIdx === -1) {
    return UNCLUSTERED_COLOR;
  }
  
  return CLUSTER_PALETTE[clusterIdx % CLUSTER_PALETTE.length];
}

/**
 * Get the size of a cluster based on UMAP points
 * @param {number} cluster - The cluster number
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {number} - Number of points in the cluster
 */
export function getClusterSize(cluster, umapPoints) {
  if (!umapPoints || umapPoints.length === 0) {
    return 0;
  }
  
  return umapPoints.filter(p => p.cluster === cluster).length;
}

/**
 * Get cluster information for a specific image index
 * @param {number} globalIndex - The global index of the image
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {Object|null} - Object with cluster, color, and size, or null if not found
 */
export function getClusterInfoForImage(globalIndex, umapPoints) {
  if (!umapPoints || umapPoints.length === 0) {
    return null;
  }
  
  const point = umapPoints.find(p => p.index === globalIndex);
  if (!point) {
    return null;
  }
  
  const cluster = point.cluster;
  const color = getClusterColorFromPoints(cluster, umapPoints);
  const size = getClusterSize(cluster, umapPoints);
  
  return { cluster, color, size };
}
